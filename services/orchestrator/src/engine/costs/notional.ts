// The NOTIONAL cost axis (FOCUS ListCost) — the COMPUTED list value of a call's
// tokens, and the CLOSED reason it is or is not a number.
//
// Split out of `sources.ts` (which owns REAL spend, a metered fact) so the two axes
// do not share a file: they answer different questions, from different sources,
// with different honesty contracts. Real spend is a FACT or NULL; notional is an
// ESTIMATE at the model's live list price, computed for EVERY billing mode
// (including subscription/self-hosted, where real spend is legitimately NULL).
// Notional is NEVER written to `cost_usd` and is NEVER summed by the budget gate.

import { z } from "zod";

import type { TokenUsage } from "../providers/types.js";
import type { ModelPriceLookup } from "./pricing/compositePriceSource.js";
import { defaultModelPriceSource, type ModelPrice, type PriceTier } from "./pricing/modelPriceSource.js";
import type { CostSource } from "./sources.js";

// WHY A NULL NOTIONAL COST HAPPENED — a CLOSED enum, recorded on every row.
//
// A bare NULL is unqueryable and unactionable: an operator seeing `notional_cost_usd
// IS NULL` cannot tell a legitimately-empty answerer row from a model-id regression
// from an outage at the price source. All three used to look identical, and the
// worst of them (a real call with no model id) was additionally SILENT, because the
// loud-event guard skipped exactly that case.
//
// Every value below is written to `cost_source_raw.notionalReason` and onto the
// `cost.resolved` payload, so "why is this null" is a SQL query, not an
// investigation.
export const NotionalReason = z.enum([
  // Priced. `notional_cost_usd` is a number.
  "priced",
  // Priced from the CLI's own ccusage figure, which outranks a list rate.
  "ccusage",
  // NULL, and a DEFECT: a real call whose model id never reached the recorder.
  "model_id_absent",
  // NULL, and a fact about the model: no price source lists this id.
  "model_not_listed",
  // NULL, and an INFRASTRUCTURE fault: no price source could be consulted. The
  // model may well be priceable — we could not ask. Recoverable by a reprice.
  "price_source_unavailable",
  // NULL because the credential ref is unrecognized, so provider AND model are
  // untrustworthy. Already narrated by `cost.unattributed`.
  "unattributed_credential",
  // NULL because the call consumed no tokens. Legitimately empty, not a gap.
  "no_tokens",
]);
export type NotionalReason = z.infer<typeof NotionalReason>;

// The notional estimate plus the reason it is (or is not) a number.
export interface NotionalResult {
  usd: string | null;
  reason: NotionalReason;
}

// Reasons that represent a GAP an operator should be able to see and act on, as
// opposed to an honest empty (`no_tokens`) or an already-narrated misconfig
// (`unattributed_credential`, covered by `cost.unattributed`).
export const LoudNotionalReason = z.enum(["model_id_absent", "model_not_listed", "price_source_unavailable"]);
export type LoudNotionalReason = z.infer<typeof LoudNotionalReason>;

const LOUD_NOTIONAL_REASONS: ReadonlySet<NotionalReason> = new Set<NotionalReason>(LoudNotionalReason.options);

// A TYPE PREDICATE, not a boolean: narrowing to `LoudNotionalReason` is what makes
// the `cost.notional_unpriced` payload's closed `reasonCode` enum a compile-time
// guarantee. Adding a reason to NotionalReason without deciding whether it is loud
// is then a type error at the emission site rather than a runtime schema rejection.
export function notionalReasonIsLoud(reason: NotionalReason): reason is LoudNotionalReason {
  return LOUD_NOTIONAL_REASONS.has(reason);
}

// computeNotionalUsd returns the NOTIONAL estimate (FOCUS ListCost) of a call's
// tokens for the cost_records.notional_cost_usd column, or null when the call's
// MODEL is not in the maintained price source. Unlike computeCostUsd (REAL spend,
// a metered FACT), this is a COMPUTED estimate sourced from the real LiteLLM
// model-price data (ModelPriceSource), keyed by model id — so notional value is the
// comparable, forecastable figure for EVERY billing mode (incl. subscription/
// self_hosted, where real spend is $0/NULL). A positive ccusage figure (kept on
// `notionalCcusageCostUsd` even when dropped from real spend) is the more-accurate
// notional value, so it is PREFERRED; otherwise the model price prices the same
// per-bucket arithmetic. NULL-and-loud: null when the model is unpriced (missing
// model / unattributed) — an HONEST state, NEVER a fake estimate. Notional is
// NEVER written to cost_usd.
export function computeNotionalUsd(
  source: CostSource,
  tokens: TokenUsage,
  priceSource: ModelPriceLookup = defaultModelPriceSource(),
): NotionalResult {
  // A positive ccusage figure is the most-accurate notional value when present.
  if (source.notionalCcusageCostUsd !== null) {
    return { usd: formatUsd(source.notionalCcusageCostUsd), reason: "ccusage" };
  }
  // An unattributed misconfig is unpriced on BOTH axes — we never even look up a
  // notional rate (we cannot trust its provider/model).
  if (source.billingMode === "unattributed") {
    return { usd: null, reason: "unattributed_credential" };
  }
  // NO MODEL ID. Previously this shared the silent-null branch above, and that is
  // precisely how the decorator defect (§11) hid for so long: every production row
  // arrived here, recorded NULL, and said nothing. It is now its OWN reason code,
  // because a real token-bearing call that does not know which model it called is a
  // DEFECT in the caller, not a property of the call.
  if (source.model === "") {
    return { usd: null, reason: "model_id_absent" };
  }
  // A zero-token call has a legitimately-zero notional value and nothing to price.
  // Distinguished so it never pollutes the unpriced signal.
  //
  // Judged on the FIVE BILLABLE BUCKETS, not on `totalTokens`. `totalTokens` is
  // "provider-reported total, else the sum" (providers/types.ts), so it is an
  // INDEPENDENT input that can contradict the buckets — and a provider reporting
  // `total_tokens: 0` alongside real buckets would otherwise short-circuit a
  // genuinely billable call into a silent `no_tokens`, reintroducing exactly the
  // unexplained null this change removes. Priced from what we would bill.
  if (billableTokenTotal(tokens) === 0) {
    return { usd: null, reason: "no_tokens" };
  }
  // The LIVE list price for this model — OpenRouter's own quote when it sells the
  // model, else the LiteLLM table for a direct-vendor route.
  const lookupProvider = providerForLookup(source.provider);
  const price = priceSource.lookup(source.model, lookupProvider);
  if (price !== null) {
    return { usd: formatUsd(priceTokensAtModelPrice(price, tokens)), reason: "priced" };
  }
  // NULL — but never silently, and never as a guess. Which of the two very
  // different nulls is this?
  //   unavailable → we could not consult a price source at all (no live fetch has
  //                 succeeded). This says NOTHING about the model; it is an
  //                 infrastructure fault and is recoverable by a later reprice.
  //   ready       → we asked, and the model genuinely is not listed. That is a fact
  //                 about the model (or a drifted/bogus id such as the literal
  //                 "default" managed mode records).
  //
  // Asked of the SAME route the lookup used. Health is NOT a property of "the price
  // sources" collectively: over the composite, the always-seeded LiteLLM leg would
  // otherwise answer on behalf of the marketplace leg and turn a cold-OpenRouter
  // outage into a verdict about the model. See `CompositeModelPriceSource.health`.
  return {
    usd: null,
    reason: priceSource.health(lookupProvider) === "ready" ? "model_not_listed" : "price_source_unavailable",
  };
}

// The provider hint passed to ModelPriceSource.lookup: a real provider name when
// we have one, else undefined (so the lookup keys on the model id alone rather
// than asserting against an `unknown`/placeholder provider that would never match
// upstream's `litellm_provider`).
function providerForLookup(provider: string): string | undefined {
  return provider === "" || provider === "unknown" ? undefined : provider;
}

// The call's PROMPT-side token total — the quantity a marketplace's long-context
// tier threshold is measured against. Tanren stores prompt tokens in three DISJOINT
// buckets (uncached, cache-read, cache-write), so the threshold must be compared
// against their sum, not against `inputTokens` alone (which excludes cached tokens
// after the de-overlap in `tokenUsageFromRecord`). Getting this wrong would keep a
// 400 000-token call on the cheap tier.
function promptTokenTotal(tokens: TokenUsage): number {
  return tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
}

// Every token bucket the notional arithmetic actually bills. Deliberately NOT
// `totalTokens` — see the `no_tokens` branch in `computeNotionalUsd`.
export function billableTokenTotal(tokens: TokenUsage): number {
  return promptTokenTotal(tokens) + tokens.outputTokens + tokens.reasoningOutputTokens;
}

// Select the applicable long-context tier: the HIGHEST tier whose prompt-token floor
// this call reaches. `tiers` is ascending, so the last match wins. No tiers, or a
// call below every floor, → undefined (the model's flat rates apply).
function selectTier(price: ModelPrice, tokens: TokenUsage): PriceTier | undefined {
  const prompt = promptTokenTotal(tokens);
  let selected: PriceTier | undefined;
  for (const tier of price.tiers) {
    if (prompt >= tier.minPromptTokens) {
      selected = tier;
    }
  }
  return selected;
}

// Per-bucket NOTIONAL arithmetic over a maintained ModelPrice. reasoning tokens
// bill at the output rate; cached-input at the cache-READ rate when the model
// lists one, else at the input rate; cache-creation at the cache-CREATION rate
// when listed, else at the input rate. An axis the model does not list (null) is
// treated as the input rate where it stands in for input-like tokens, else 0.
//
// A selected long-context tier OVERRIDES the flat rate on each axis it restates,
// per-axis: OpenRouter's overrides commonly restate prompt+completion but not the
// cache axes, and an unrestated axis keeps the base rate.
// Resolve one axis's per-million rate: the TIER's restatement when it has one, else
// the model's flat rate. Hoisted (it captures nothing) so it is not rebuilt per call.
function perMillion(tierRate: number | undefined, base: number | undefined): number | undefined {
  return tierRate === undefined ? base : tierRate * 1_000_000;
}

function priceTokensAtModelPrice(price: ModelPrice, tokens: TokenUsage): number {
  const tier = selectTier(price, tokens);
  const inputPerMillion = perMillion(tier?.inputCostPerToken, price.input?.costPerMillion) ?? 0;
  const outputPerMillion = perMillion(tier?.outputCostPerToken, price.output?.costPerMillion) ?? inputPerMillion;
  const cacheReadPerMillion =
    perMillion(tier?.cacheReadCostPerToken, price.cacheRead?.costPerMillion) ?? inputPerMillion;
  const cacheCreationPerMillion =
    perMillion(tier?.cacheCreationCostPerToken, price.cacheCreation?.costPerMillion) ?? inputPerMillion;
  return (
    (tokens.inputTokens * inputPerMillion) / 1_000_000 +
    (tokens.cachedInputTokens * cacheReadPerMillion) / 1_000_000 +
    (tokens.cacheCreationTokens * cacheCreationPerMillion) / 1_000_000 +
    (tokens.outputTokens * outputPerMillion) / 1_000_000 +
    (tokens.reasoningOutputTokens * outputPerMillion) / 1_000_000
  );
}

// Six-decimal fixed-precision, matching `cost_records.notional_cost_usd`
// numeric(14,6). Local to this module so the notional axis cannot drift from the
// real-spend formatter by accident.
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.000000";
  }
  return value.toFixed(6);
}
