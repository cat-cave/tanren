// Cost-attribution model. Token accounting is MANDATORY and first-class;
// cost in dollars is BEST-EFFORT.
//
// Two orthogonal axes describe every recorded call:
//
//   billing_mode — how the credential is billed (from the auth ref):
//     per_token    — token-billed API key (provider list prices apply)
//     subscription — server-enforced rolling/weekly/monthly window
//                    (ChatGPT/Claude subscription via the CLI). There is NO
//                    fixed token denominator, so no dollar figure is invented.
//     self_hosted  — local GPU / fixed-fee endpoint; no per-call dollar basis.
//
//   cost_basis — how the dollar figure (if any) was derived:
//     ccusage          — derived from the ccusage tool (next PR).
//     provider_pricing — computed from a known per-token price table.
//     unknown          — no reliable basis; cost_usd IS NULL. This is an
//                        HONEST, ALLOWED state — it does NOT fail the task.
//
// Subscription windows are percent-of-window limits, not token budgets, so we
// never fabricate a "$20 / 50M tokens" estimate. When we cannot price a call
// we record cost_usd = NULL with cost_basis = 'unknown' and move on.
import { z } from "zod";
import type { TokenUsage } from "../providers/types.js";

export const BillingMode = z.enum(["per_token", "subscription", "self_hosted"]);
export type BillingMode = z.infer<typeof BillingMode>;

export const CostBasis = z.enum(["ccusage", "provider_pricing", "credits", "unknown"]);
export type CostBasis = z.infer<typeof CostBasis>;

// Dollar value of one prepaid Codex/ChatGPT credit. Observed on the live Pro
// account: 1000 credits for $40 (and $10 for 250) → $0.04/credit (pre-tax list
// rate). Credit drawdown is the REAL marginal spend for subscription-overage
// usage (within-window usage draws no credits), so it is recorded as a first-
// class cost (cost_basis='credits'). This rate is account/plan-specific and
// should become per-credential config when more providers are wired.
export const DEFAULT_CREDIT_USD_RATE = 0.04;

export const RawUsage = z.record(z.string(), z.unknown());
export type RawUsage = z.infer<typeof RawUsage>;

// CostSource is the typed result of resolving an auth ref + token usage into a
// (possibly null) dollar figure plus its provenance. Built by resolveCostSource
// and persisted by the CostRecorder.
export interface CostSource {
  billingMode: BillingMode;
  costBasis: CostBasis;
  provider: string;
  // Per-token rate entry when costBasis === 'provider_pricing', else null.
  rate: ProviderRate | null;
  // Real dollar figure carried over from ccusage when costBasis === 'ccusage',
  // else null. ccusage reports actual billed/computed cost from the CLI's own
  // session logs, so when present it OUTRANKS the static provider table.
  ccusageCostUsd: number | null;
  rawUsage: RawUsage;
}

export interface AttributionInput {
  cli: "codex" | "claude" | "opencode" | "aider" | "fake";
  authRef: string;
  // Real dollar figure for THIS call, derived from ccusage (apportioned by
  // token share against the run-level ccusage total — see CostRecorder
  // .reconcileRunCostFromCcusage). A positive value wins over the static
  // provider table regardless of billing mode; null/0 falls back.
  ccusageCostUsd?: number | null;
  rawUsage: RawUsage;
}

// Provider price tables. Pinned at known v0 list prices. Refining these is a
// separate concern from cost attribution; see docs/operator-guide/costs.md
// for the source-of-truth dates.
export interface ProviderRate {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion: number | null;
}

const providerRateTable: Record<string, ProviderRate> = {
  openai: { inputCostPerMillion: 2.5, outputCostPerMillion: 10, cachedInputCostPerMillion: 1.25 },
  anthropic: { inputCostPerMillion: 3, outputCostPerMillion: 15, cachedInputCostPerMillion: 0.3 },
  openrouter: { inputCostPerMillion: 5, outputCostPerMillion: 15, cachedInputCostPerMillion: null },
};

export function providerRate(provider: string): ProviderRate | undefined {
  return providerRateTable[provider];
}

// Classification of a credential ref into a billing mode. Order matters:
// subscription bundles must win over per_token when the ref is a Codex/Claude
// ChatGPT subscription bundle so a subscription operator is never charged at
// provider list prices.
type RefClassification =
  | { billingMode: "subscription"; provider: string }
  | { billingMode: "per_token"; provider: string }
  | { billingMode: "self_hosted"; provider: string }
  | { billingMode: "unknown"; provider: string };

export function classifyAuthRef(authRef: string): RefClassification {
  if (authRef === "") {
    return { billingMode: "unknown", provider: "unknown" };
  }
  // Codex/Claude CLI ChatGPT-subscription bundles live under credential/codex/.
  // These are subscription-window dollars, never per-token.
  if (authRef.startsWith("credential/codex/")) {
    return { billingMode: "subscription", provider: "openai" };
  }
  if (authRef.startsWith("credential/anthropic/")) {
    return { billingMode: "per_token", provider: "anthropic" };
  }
  if (authRef.startsWith("credential/openai-api/")) {
    return { billingMode: "per_token", provider: "openai" };
  }
  if (authRef.startsWith("credential/openrouter/")) {
    return { billingMode: "per_token", provider: "openrouter" };
  }
  if (authRef.startsWith("credential/self-hosted/")) {
    return { billingMode: "self_hosted", provider: refTailSegment(authRef) ?? "self-hosted" };
  }
  return { billingMode: "unknown", provider: "unknown" };
}

function refTailSegment(ref: string): string | undefined {
  const parts = ref.split("/").filter((part) => part !== "");
  return parts[parts.length - 1];
}

// resolveCostSource maps an auth ref to a billing mode and a cost basis.
// It NEVER throws for an unrecognized ref: an unknown billing mode resolves to
// cost_basis = 'unknown' (cost_usd will be null). Token accounting still
// happens for every call.
//
// Cost-basis precedence (PROJECT_BRIEF §4): a positive ccusage figure is a
// REAL billed/computed dollar amount from the CLI's own logs, so it wins over
// everything — even for a subscription credential, where ccusage may still
// compute a comparable cost. Otherwise a per_token credential with a known
// provider rate prices from the static table; anything else is honestly
// unknown (cost_usd NULL), which does NOT fail the task.
export function resolveCostSource(input: AttributionInput): CostSource {
  const classification = classifyAuthRef(input.authRef);
  const ccusageCostUsd =
    typeof input.ccusageCostUsd === "number" && Number.isFinite(input.ccusageCostUsd) && input.ccusageCostUsd > 0
      ? input.ccusageCostUsd
      : null;
  const billingMode: BillingMode =
    classification.billingMode === "unknown" ? "self_hosted" : classification.billingMode;
  if (ccusageCostUsd !== null) {
    return {
      billingMode,
      costBasis: "ccusage",
      provider: classification.provider,
      rate: null,
      ccusageCostUsd,
      rawUsage: input.rawUsage,
    };
  }
  if (classification.billingMode === "per_token") {
    const rate = providerRate(classification.provider) ?? null;
    return {
      billingMode: "per_token",
      // Known price → provider_pricing; otherwise we cannot price it.
      costBasis: rate === null ? "unknown" : "provider_pricing",
      provider: classification.provider,
      rate,
      ccusageCostUsd: null,
      rawUsage: input.rawUsage,
    };
  }
  // subscription, self_hosted, or unknown → no reliable per-call dollar basis.
  return {
    billingMode,
    costBasis: "unknown",
    provider: classification.provider,
    rate: null,
    ccusageCostUsd: null,
    rawUsage: input.rawUsage,
  };
}

// computeCostUsd returns a fixed-precision dollar string for the NUMERIC(14,6)
// cost_records.cost_usd column, or null when cost is genuinely unknown
// (subscription / self-hosted / unpriced model). NO fake estimate.
export function computeCostUsd(source: CostSource, tokens: TokenUsage): string | null {
  if (source.costBasis === "ccusage" && source.ccusageCostUsd !== null) {
    return formatUsd(source.ccusageCostUsd);
  }
  if (source.costBasis !== "provider_pricing" || source.rate === null) {
    return null;
  }
  const rate = source.rate;
  // reasoning tokens are billed at the output rate; cached-input at the cache
  // rate when known, otherwise treated as uncached input.
  const cacheRate = rate.cachedInputCostPerMillion ?? rate.inputCostPerMillion;
  const dollars =
    (tokens.inputTokens * rate.inputCostPerMillion) / 1_000_000 +
    (tokens.cachedInputTokens * cacheRate) / 1_000_000 +
    (tokens.cacheCreationTokens * rate.inputCostPerMillion) / 1_000_000 +
    (tokens.outputTokens * rate.outputCostPerMillion) / 1_000_000 +
    (tokens.reasoningOutputTokens * rate.outputCostPerMillion) / 1_000_000;
  return formatUsd(dollars);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.000000";
  }
  return value.toFixed(6);
}
