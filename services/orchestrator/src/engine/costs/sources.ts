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
//
// BUDGET-SAFETY (C1): an HONESTLY-unpriceable call (a recognized subscription /
// self-hosted credential, or the no-credential fixture path) is a legitimate
// NULL-dollar row with billing_mode in {subscription,self_hosted} and
// cost_basis='unknown'. An UNRECOGNIZED credential ref is a DIFFERENT thing — a
// misconfiguration. It must NOT be silently relabeled as a $0 self-hosted row
// (which would let unbounded real spend slip under a configured ceiling). It is
// recorded with the distinct billing_mode='unattributed' + cost_basis=
// 'unattributed' (cost_usd still NULL — we genuinely cannot price it) so the
// recorder can emit `cost.unattributed` AND the budget gate can FAIL CLOSED on
// it rather than assume $0.
import { z } from "zod";
import type { TokenUsage } from "../providers/types.js";

export const BillingMode = z.enum(["per_token", "subscription", "self_hosted", "unattributed"]);
export type BillingMode = z.infer<typeof BillingMode>;

export const CostBasis = z.enum(["ccusage", "provider_pricing", "credits", "unknown", "unattributed"]);
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
  // BUDGET-SAFETY (C1): the SAFE ref-KIND label (e.g. `credential/mystery`, never
  // the secret value) when the credential ref was UNRECOGNIZED — set iff
  // billingMode/costBasis are 'unattributed'. The recorder emits a
  // `cost.unattributed` event carrying this so an operator sees the misconfig,
  // and the budget gate fails closed on the resulting NULL-dollar row. `null` for
  // every honest (priced or honestly-unpriceable) source.
  unattributedRefKind: string | null;
  rawUsage: RawUsage;
}

export interface AttributionInput {
  cli: "codex" | "claude" | "opencode" | "aider" | "pi" | "reasonix" | "fake";
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
//
// Three honest terminal shapes plus two failure shapes:
//   - subscription / per_token / self_hosted — a RECOGNIZED ref kind.
//   - absent      — the empty-ref no-credential path (fixtures / token-only
//                   accounting calls). Honestly unpriceable, NOT a misconfig.
//   - unrecognized — a NON-EMPTY ref that matches no known `credential/<kind>/`
//                   prefix. A MISCONFIGURATION: it must never be silently coerced
//                   to a $0 self-hosted row (BUDGET-SAFETY C1). `refKind` names
//                   the ref's KIND segment only (never the secret value) for the
//                   `cost.unattributed` event.
type RefClassification =
  | { billingMode: "subscription"; provider: string }
  | { billingMode: "per_token"; provider: string }
  | { billingMode: "self_hosted"; provider: string }
  | { billingMode: "absent"; provider: string }
  | { billingMode: "unrecognized"; provider: string; refKind: string };

export function classifyAuthRef(authRef: string): RefClassification {
  if (authRef === "") {
    // No credential ref at all — the token-only / fixture path. Honestly
    // unpriceable (subscription-equivalent NULL dollars), never a misconfig.
    return { billingMode: "absent", provider: "unknown" };
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
  // An UNRECOGNIZED non-empty ref. Do NOT silently relabel to self_hosted/$0.
  return { billingMode: "unrecognized", provider: "unknown", refKind: refKindOf(authRef) };
}

function refTailSegment(ref: string): string | undefined {
  const parts = ref.split("/").filter((part) => part !== "");
  return parts.at(-1);
}

// The KIND segments of a credential ref, SAFE to surface in an event: the leading
// path segments WITHOUT the final identifier (the secret name). E.g.
// `credential/mystery/prod-key` → `credential/mystery`. Never the secret value.
export function refKindOf(ref: string): string {
  const parts = ref.split("/").filter((part) => part !== "");
  if (parts.length <= 1) {
    return parts[0] ?? "unknown";
  }
  return parts.slice(0, -1).join("/");
}

// resolveCostSource maps an auth ref to a billing mode and a cost basis.
// It NEVER throws for an unrecognized ref (token accounting still happens for
// every call), but it NO LONGER silently coerces an unrecognized ref into a $0
// self-hosted row — that would defeat the budget ceiling (BUDGET-SAFETY C1).
//
// Cost-basis precedence (PROJECT_BRIEF §4): a positive ccusage figure is a
// REAL billed/computed dollar amount from the CLI's own logs, so it wins over
// everything — even for a subscription credential, where ccusage may still
// compute a comparable cost. Otherwise a per_token credential with a known
// provider rate prices from the static table; a RECOGNIZED subscription/
// self-hosted (or the no-credential `absent` path) is honestly unknown (cost_usd
// NULL); an UNRECOGNIZED ref is `unattributed` (also NULL, but flagged so the
// recorder narrates it and the budget gate fails closed). Either way the task
// does NOT fail here.
export function resolveCostSource(input: AttributionInput): CostSource {
  const classification = classifyAuthRef(input.authRef);
  const ccusageCostUsd =
    typeof input.ccusageCostUsd === "number" && Number.isFinite(input.ccusageCostUsd) && input.ccusageCostUsd > 0
      ? input.ccusageCostUsd
      : null;
  if (ccusageCostUsd !== null) {
    // A real measured dollar figure prices the call regardless of ref kind —
    // including an otherwise-unrecognized ref, which is then NOT unattributed.
    return {
      billingMode: ccusageBillingMode(classification.billingMode),
      costBasis: "ccusage",
      provider: classification.provider,
      rate: null,
      ccusageCostUsd,
      unattributedRefKind: null,
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
      unattributedRefKind: null,
      rawUsage: input.rawUsage,
    };
  }
  if (classification.billingMode === "unrecognized") {
    // The misconfig path: cost_usd stays NULL (we genuinely cannot price it), but
    // it is recorded as `unattributed` (NOT $0 self_hosted) so the recorder emits
    // `cost.unattributed` and the budget gate fails closed on the NULL row.
    return {
      billingMode: "unattributed",
      costBasis: "unattributed",
      provider: classification.provider,
      rate: null,
      ccusageCostUsd: null,
      unattributedRefKind: classification.refKind,
      rawUsage: input.rawUsage,
    };
  }
  // subscription, self_hosted, or absent → an HONESTLY-unpriceable NULL-dollar
  // row. `absent` (the no-credential path) maps to self_hosted, unchanged.
  return {
    billingMode: classification.billingMode === "absent" ? "self_hosted" : classification.billingMode,
    costBasis: "unknown",
    provider: classification.provider,
    rate: null,
    ccusageCostUsd: null,
    unattributedRefKind: null,
    rawUsage: input.rawUsage,
  };
}

// The billing_mode stamped on a ccusage-priced row: a recognized mode is kept;
// an `absent`/`unrecognized` ref that nonetheless produced a real ccusage dollar
// figure is recorded as self_hosted (a real measured cost, so NOT unattributed).
function ccusageBillingMode(mode: RefClassification["billingMode"]): BillingMode {
  switch (mode) {
    case "subscription":
    case "per_token":
    case "self_hosted":
      return mode;
    default:
      return "self_hosted";
  }
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
