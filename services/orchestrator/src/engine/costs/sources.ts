// Cost-attribution model. Token accounting is MANDATORY and first-class;
// cost in dollars is BEST-EFFORT.
//
// Two orthogonal axes describe every recorded call:
//
//   billing_mode — how the credential is billed (from the auth ref):
//     per_token    — token-billed API key. A dollar figure exists ONLY when a
//                    real-spend FACT was captured for the call (the provider's
//                    own per-call charge, ccusage's billed figure, or credit
//                    drawdown). NO list-rate table is invented for it.
//     subscription — server-enforced rolling/weekly/monthly window
//                    (ChatGPT/Claude subscription via the CLI). There is NO
//                    fixed token denominator, so no dollar figure is invented.
//     self_hosted  — local GPU / fixed-fee endpoint; no per-call dollar basis.
//
//   cost_basis — how the dollar figure (if any) was derived:
//     ccusage           — derived from the ccusage tool (REAL billed/computed cost).
//     provider_response — the provider's OWN authoritative per-call charge,
//                         returned in its API response (OpenRouter's
//                         `usage.cost` / `/api/v1/generation.total_cost`). This
//                         is the REAL amount deducted from the balance — no
//                         inference markup, native tokenizer — so it is the most
//                         accurate real-spend figure and OUTRANKS every estimate.
//     credits           — prepaid Codex/ChatGPT credit drawdown — the REAL
//                         marginal spend for subscription-overage usage (stamped
//                         by the run-end credit reconcile, never here).
//     unknown           — no reliable basis; cost_usd IS NULL. This is an
//                         HONEST, ALLOWED state — it does NOT fail the task. A
//                         `per_token` call with NO captured real-spend FACT lands
//                         here: real spend (`cost_usd`) is a METERED FACT or NULL,
//                         NEVER a list-rate guess.
//
// REAL SPEND IS A FACT (binding). `cost_usd` is written ONLY from a real-spend
// FACT (provider_response / ccusage / credits). There is NO hardcoded price table
// for ANY provider, so a `per_token` credential with no captured fact (e.g. a
// BYOK anthropic/openai-api key, whose real charge lands on the upstream invoice
// we cannot read) records cost_usd = NULL with cost_basis = 'unknown'. The NOTIONAL
// estimate (notional_cost_usd) is a SEPARATE, COMPUTED figure sourced from the
// maintained LiteLLM model-price source (computeNotionalUsd), never written to
// cost_usd.
//
// BUDGET-SAFETY (C1): an HONESTLY-unpriceable call (a recognized per_token key
// with no fact, a subscription / self_hosted credential, or the no-credential
// fixture path) is a legitimate NULL-dollar row with cost_basis='unknown'. An
// UNRECOGNIZED credential ref is a DIFFERENT thing — a misconfiguration. It must
// NOT be silently relabeled as a $0 self-hosted row (which would let unbounded
// real spend slip under a configured ceiling). It is recorded with the distinct
// billing_mode='unattributed' + cost_basis='unattributed' (cost_usd still NULL —
// we genuinely cannot price it) so the recorder can emit `cost.unattributed` AND
// the budget gate can FAIL CLOSED on it rather than assume $0.
import { z } from "zod";
import type { TokenUsage } from "../providers/types.js";

export const BillingMode = z.enum(["per_token", "subscription", "self_hosted", "unattributed"]);
export type BillingMode = z.infer<typeof BillingMode>;

export const CostBasis = z.enum(["ccusage", "provider_response", "credits", "unknown", "unattributed"]);
export type CostBasis = z.infer<typeof CostBasis>;

// The dollar value of one prepaid credit is account/plan-specific (the old
// `DEFAULT_CREDIT_USD_RATE = 0.04` was a single Codex-Pro observation: 1000
// credits for $40). It is no longer a magic constant — it is per-credential
// CONFIG (`config/shared.ts` `CreditRates`, resolved by `creditRate.ts`), so the
// credit-drawdown → USD reconcile multiplies a real drawdown by a CONFIGURED
// rate. A credential that drew down credits with no configured rate is a LOUD
// unknown (NULL real spend + `cost.credit_rate_unknown`), never a silent guess.
export const RawUsage = z.record(z.string(), z.unknown());
export type RawUsage = z.infer<typeof RawUsage>;

// CostSource is the typed result of resolving an auth ref + token usage into a
// (possibly null) dollar figure plus its provenance. Built by resolveCostSource
// and persisted by the CostRecorder.
export interface CostSource {
  billingMode: BillingMode;
  costBasis: CostBasis;
  provider: string;
  // The model id for THIS call — the lookup key for the NOTIONAL estimate
  // (computeNotionalUsd → ModelPriceSource.lookup). Never used for real spend.
  model: string;
  // The provider's OWN authoritative per-call charge when costBasis ===
  // 'provider_response', else null. This is OpenRouter's `usage.cost` /
  // `/api/v1/generation.total_cost` — the REAL amount deducted, computed by the
  // provider from native token usage with no inference markup. It is the most
  // accurate real-spend figure, so it OUTRANKS BOTH ccusage AND everything else.
  // Only OpenRouter surfaces such a figure today; absent everywhere else.
  realProviderCostUsd: number | null;
  // Real dollar figure carried over from ccusage when costBasis === 'ccusage',
  // else null. ccusage reports actual billed/computed cost from the CLI's own
  // session logs, so when present it is a real-spend FACT.
  ccusageCostUsd: number | null;
  // BUDGET-SAFETY (C1): the SAFE ref-KIND label (e.g. `credential/mystery`, never
  // the secret value) when the credential ref was UNRECOGNIZED — set iff
  // billingMode/costBasis are 'unattributed'. The recorder emits a
  // `cost.unattributed` event carrying this so an operator sees the misconfig,
  // and the budget gate fails closed on the resulting NULL-dollar row. `null` for
  // every honest (priced or honestly-unpriceable) source.
  unattributedRefKind: string | null;
  // NOTIONAL ccusage figure: the positive ccusage dollar value for THIS call, kept
  // for the NOTIONAL axis EVEN WHEN it was dropped from real spend (a subscription's
  // ccusage figure is notional token-value, dropped from `ccusageCostUsd`/cost_usd
  // but a more-accurate NOTIONAL signal than the model-priced estimate). `null` when
  // no positive ccusage figure is present, OR for an `unattributed` ref (where we
  // cannot trust the billing model, so we never use its ccusage on EITHER axis).
  notionalCcusageCostUsd: number | null;
  rawUsage: RawUsage;
}

export interface AttributionInput {
  cli: "codex" | "claude" | "opencode" | "aider" | "pi" | "reasonix" | "fake";
  authRef: string;
  // The model id for THIS call — carried onto the CostSource for the NOTIONAL
  // estimate's model-id lookup. Empty when the call site has no model id (e.g. a
  // token-only audit row); notional is then null (no key to look up).
  model?: string;
  // The provider's OWN authoritative per-call charge for THIS call (OpenRouter's
  // `usage.cost` / `/api/v1/generation.total_cost`). A positive value is the REAL
  // deduction and OUTRANKS ccusage → costBasis becomes 'provider_response'. null/0
  // means no fact from this source.
  realProviderCostUsd?: number | null;
  // Real dollar figure for THIS call, derived from ccusage (apportioned by
  // token share against the run-level ccusage total — see CostRecorder
  // .reconcileRunCostFromCcusage). A positive value is a real-spend FACT; null/0
  // means no fact from this source.
  ccusageCostUsd?: number | null;
  rawUsage: RawUsage;
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
  // The Codex CLI ChatGPT-subscription bundle lives under credential/codex/.
  // These are subscription-window dollars, never per-token.
  if (authRef.startsWith("credential/codex/")) {
    return { billingMode: "subscription", provider: "openai" };
  }
  // The Claude CLI subscription bundle (`credential/claude/`, the OAuth/API-key
  // auth bundle — see claudeAuth.ts) is an Anthropic SUBSCRIPTION: within-window
  // usage is flat-fee ($0 real / notional-only), and "extra usage" overage bills
  // at API rates. It is subscription billing, NOT per-token. Its real overage
  // figure is NOT reachable from the local CLI path (see costs/claudeOverage.ts).
  if (authRef.startsWith("credential/claude/")) {
    return { billingMode: "subscription", provider: "anthropic" };
  }
  // `credential/anthropic/` is a raw token-billed Anthropic API KEY (BYOK), not
  // the subscription bundle above — per-token.
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

// The PROVIDER-SLUG segment of a credential ref, SAFE to surface in an event: the
// `credential/<slug>` prefix (e.g. `credential/codex/org/o1/default` →
// `credential/codex`). This is the per-PROVIDER kind (one slug per provider), the
// stable key the per-credential credit rate config (`CreditRates`) is keyed on — so
// ONE configured rate covers every credential of that provider regardless of its
// scope/name. An empty ref → `unknown`. Never the secret value.
export function credentialSlugOf(ref: string): string {
  const parts = ref.split("/").filter((part) => part !== "");
  if (parts.length === 0) {
    return "unknown";
  }
  if (parts[0] === "credential" && parts.length >= 2) {
    return `credential/${parts[1]}`;
  }
  // A non-`credential/` ref (or a bare single segment) has no provider slug; fall
  // back to its leading kind segments so the key is still secret-free + stable.
  return refKindOf(ref);
}

// A positive, finite number or null. Real-spend facts are only believed when
// they are a genuine positive figure — a 0/negative/NaN is "no fact captured".
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// resolveCostSource maps an auth ref to a billing mode and a cost basis.
// It NEVER throws for an unrecognized ref (token accounting still happens for
// every call), but it NO LONGER silently coerces an unrecognized ref into a $0
// self-hosted row — that would defeat the budget ceiling (BUDGET-SAFETY C1).
//
// REAL SPEND IS A FACT. Cost-basis precedence: the provider's OWN authoritative
// per-call charge (`provider_response`, OpenRouter's `usage.cost`) is the REAL
// deduction with no markup, so it wins. Next, a positive ccusage figure is a REAL
// billed/computed dollar amount from the CLI's own logs. With NEITHER fact, a
// `per_token` credential is `unknown`/NULL (there is NO list-rate table to fall
// back to). A RECOGNIZED subscription/self-hosted (or the no-credential `absent`
// path) is `unknown`/NULL too. An UNRECOGNIZED ref is `unattributed` (also NULL,
// but flagged so the recorder narrates it and the budget gate fails closed).
// Either way the task does NOT fail here.
export function resolveCostSource(input: AttributionInput): CostSource {
  const classification = classifyAuthRef(input.authRef);
  const model = input.model ?? "";
  const realProviderCostUsd = positiveOrNull(input.realProviderCostUsd);
  const ccusageCostUsd = positiveOrNull(input.ccusageCostUsd);
  if (classification.billingMode === "per_token") {
    // (1) HIGHEST precedence — the provider's OWN authoritative per-call charge
    // (OpenRouter's `usage.cost`). This IS the real deduction, so it sets real
    // spend directly. Notional is computed independently from the model price.
    if (realProviderCostUsd !== null) {
      return baseSource(classification.provider, model, {
        billingMode: "per_token",
        costBasis: "provider_response",
        realProviderCostUsd,
        rawUsage: input.rawUsage,
      });
    }
    // (2) A real-API (per-token) credential is the ONLY billing mode ccusage may
    // price: ccusage's figure is the REAL billed/computed cost of a metered call. A
    // ccusage figure on a SUBSCRIPTION credential is the NOTIONAL token-value of
    // flat-fee usage (no real marginal spend) and is dropped below — never spend.
    if (ccusageCostUsd !== null) {
      return baseSource(classification.provider, model, {
        billingMode: "per_token",
        costBasis: "ccusage",
        ccusageCostUsd,
        // For a per_token ccusage call real == notional, so the same figure is the
        // preferred notional value too.
        notionalCcusageCostUsd: ccusageCostUsd,
        rawUsage: input.rawUsage,
      });
    }
    // (3) NO real-spend fact captured → cost_usd is NULL. There is NO list-rate
    // table: real spend is a FACT or it is unknown. (A BYOK anthropic/openai-api
    // key, whose real charge lands on the upstream invoice we cannot read, ends
    // here.) The NOTIONAL estimate is still computed from the model price source.
    return baseSource(classification.provider, model, {
      billingMode: "per_token",
      costBasis: "unknown",
      rawUsage: input.rawUsage,
    });
  }
  if (classification.billingMode === "unrecognized") {
    // The misconfig path: cost_usd stays NULL (we genuinely cannot price it), but
    // it is recorded as `unattributed` (NOT $0 self_hosted) so the recorder emits
    // `cost.unattributed` and the budget gate fails closed on the NULL row. It is
    // unpriced on BOTH axes (we never trust an unrecognized ref's ccusage either).
    return baseSource(classification.provider, model, {
      billingMode: "unattributed",
      costBasis: "unattributed",
      unattributedRefKind: classification.refKind,
      rawUsage: input.rawUsage,
    });
  }
  // subscription, self_hosted, or absent → an HONESTLY-unpriceable NULL-dollar
  // row. `absent` (the no-credential path) maps to self_hosted, unchanged. A
  // ccusage figure (if any) is DELIBERATELY DROPPED from real spend here: for a
  // flat-fee subscription it is the notional token-value of within-window usage,
  // NOT real marginal spend, so it must never become a priced row — but it IS
  // carried on the NOTIONAL axis (the more-accurate notional value). The only REAL
  // marginal subscription spend is credit-drawdown overage, recorded as
  // `cost_basis='credits'` by the run-end credit reconcile — never by ccusage.
  return baseSource(classification.provider, model, {
    billingMode: classification.billingMode === "absent" ? "self_hosted" : classification.billingMode,
    costBasis: "unknown",
    // A positive ccusage figure — dropped from real spend above — is the
    // more-accurate NOTIONAL value, so carry it here.
    notionalCcusageCostUsd: ccusageCostUsd,
    rawUsage: input.rawUsage,
  });
}

// Build a CostSource with the null/default fields filled in, overriding only what
// a branch sets. Keeps every branch a single small object literal (no repeated
// null boilerplate) so a new field is added in ONE place.
function baseSource(
  provider: string,
  model: string,
  over: Partial<CostSource> & Pick<CostSource, "billingMode" | "costBasis" | "rawUsage">,
): CostSource {
  return {
    provider,
    model,
    realProviderCostUsd: null,
    ccusageCostUsd: null,
    unattributedRefKind: null,
    notionalCcusageCostUsd: null,
    ...over,
  };
}

// computeCostUsd returns a fixed-precision dollar string for the NUMERIC(14,6)
// cost_records.cost_usd column, or null when cost is genuinely unknown
// (subscription / self-hosted / a per_token call with no captured fact). REAL
// SPEND IS A FACT: a figure is returned ONLY for a real-spend basis
// (provider_response / ccusage). There is NO list-rate estimate. The `credits`
// basis is stamped later by the run-end reconcile, not here.
export function computeCostUsd(source: CostSource, _tokens: TokenUsage): string | null {
  // HIGHEST precedence — the provider's OWN authoritative per-call charge
  // (OpenRouter's `usage.cost`). It IS the real deduction, so it is the dollar
  // figure verbatim; tokens are irrelevant (the provider already priced it).
  if (source.costBasis === "provider_response" && source.realProviderCostUsd !== null) {
    return formatUsd(source.realProviderCostUsd);
  }
  if (source.costBasis === "ccusage" && source.ccusageCostUsd !== null) {
    return formatUsd(source.ccusageCostUsd);
  }
  // Every other basis (unknown / unattributed / subscription / self_hosted) has NO
  // real-spend fact → cost_usd is NULL. No list-rate table, no fake estimate.
  return null;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.000000";
  }
  return value.toFixed(6);
}
