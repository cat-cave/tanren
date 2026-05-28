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

export const CostBasis = z.enum(["ccusage", "provider_pricing", "unknown"]);
export type CostBasis = z.infer<typeof CostBasis>;

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
  rawUsage: RawUsage;
}

export interface AttributionInput {
  cli: "codex" | "claude" | "opencode" | "fake";
  authRef: string;
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
  openrouter: { inputCostPerMillion: 5, outputCostPerMillion: 15, cachedInputCostPerMillion: null }
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
// TODO(P2A-cost-monitors-wiring): the real ccusage/codexbar monitors now live
// in services/orchestrator/src/engine/usage/ (runner-side over SSH). The NEXT
// PR plugs them in here — a per_token call with a positive ccusage costUSD
// resolves to cost_basis = 'ccusage', and subscription-window percent-of-window
// data attaches to the raw payload. This PR ships only the monitors + events.
export function resolveCostSource(input: AttributionInput): CostSource {
  const classification = classifyAuthRef(input.authRef);
  if (classification.billingMode === "per_token") {
    const rate = providerRate(classification.provider) ?? null;
    return {
      billingMode: "per_token",
      // Known price → provider_pricing; otherwise we cannot price it.
      costBasis: rate === null ? "unknown" : "provider_pricing",
      provider: classification.provider,
      rate,
      rawUsage: input.rawUsage
    };
  }
  // subscription, self_hosted, or unknown → no reliable per-call dollar basis.
  return {
    billingMode: classification.billingMode === "unknown" ? "self_hosted" : classification.billingMode,
    costBasis: "unknown",
    provider: classification.provider,
    rate: null,
    rawUsage: input.rawUsage
  };
}

// computeCostUsd returns a fixed-precision dollar string for the NUMERIC(14,6)
// cost_records.cost_usd column, or null when cost is genuinely unknown
// (subscription / self-hosted / unpriced model). NO fake estimate.
export function computeCostUsd(source: CostSource, tokens: TokenUsage): string | null {
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
