import { z } from "zod";

// Loud cost-observability failures remain separate from the substrate schemas so
// that both domains retain room for future fail-closed payload additions.
export const CostProviderCaptureFailedPayload = z
  .object({
    generationId: z.string(),
    detail: z.string(),
    reason: z.string(),
  })
  .strict();

// The CLOSED subset of NotionalReason values that represent an ACTIONABLE GAP (as
// opposed to an honest empty or an already-narrated misconfig). Only these fire
// `cost.notional_unpriced`. Mirrors `LOUD_NOTIONAL_REASONS` in `costs/sources.ts`.
const UnpricedNotionalReason = z.enum(["model_id_absent", "model_not_listed", "price_source_unavailable"]);

export const CostNotionalUnpricedPayload = z
  .object({
    provider: z.string(),
    model: z.string(),
    cli: z.string(),
    taskId: z.string(),
    // WHICH gap this is — the machine-readable discriminator. `model_id_absent` is
    // a tanren defect, `model_not_listed` is a fact about the model, and
    // `price_source_unavailable` is an infrastructure fault that a later reprice can
    // still fix. Collapsing them into prose made all three unqueryable.
    reasonCode: UnpricedNotionalReason,
    reason: z.string(),
  })
  .strict();

// The CLOSED set of reasons a route can produce no real-spend FACT. Mirrors
// `costs/meterability.ts` UnmeterableReason — an unmeterable route must always name
// WHICH known limitation it hit, never "unknown".
const UnmeterableReason = z.enum(["harness_discards_generation_id", "byok_upstream_invoice"]);

// cost.route_unmeterable — emitted ONCE at run setup, ceiling or no ceiling,
// whenever the run's (cli × credential) route can produce no per-call real-spend
// fact. Without it an operator on an unbudgeted project has no signal that
// `cost_usd` will be NULL for the whole run until a spend report reads $0.
export const CostRouteUnmeterablePayload = z
  .object({
    cli: z.string(),
    // The SAFE ref-kind label (leading path segments, secret name stripped).
    refKind: z.string(),
    reason: UnmeterableReason,
    // The secret-free evidence for the limitation (which layer drops what).
    detail: z.string(),
  })
  .strict();

// cost.ceiling_unenforceable — a configured dollar ceiling over a route whose rows
// all land cost_usd = NULL on a REAL-spend-bearing billing mode (`per_token` with no
// capture path, or `unattributed` from an unrecognized ref). The budget gate counts
// exactly those as unpriced and fails CLOSED on them; because the rows are the run's
// OWN, raising the ceiling cannot clear the pause. The run is refused at SETUP
// instead of deadlocking mid-flight, and `remedy` names the fix that works.
// Why a configured ceiling cannot be ENFORCED — a SUPERSET of UnmeterableReason,
// and deliberately not that enum: the two metering limitations are facts about what
// tanren/the harness CANNOT do, whereas `unrecognized_credential_ref` is an operator
// MISCONFIGURATION. Widening `UnmeterableReason` itself would let a config error be
// narrated by `cost.route_unmeterable` as a platform limitation, which is exactly
// the laundering `costs/meterability.ts` refuses to do. Both nevertheless deadlock a
// run under a ceiling identically (NULL cost_usd on a real-spend-bearing billing
// mode ⇒ `unpriced_spend` on the run's OWN rows), so both are refused here.
//
// The reason DETERMINES the billing mode, so the two travel as a discriminated pair
// rather than as independent fields: an unrecognized ref lands `'unattributed'`
// rows, a metering limitation lands `'per_token'` ones. A payload claiming
// `unrecognized_credential_ref` over `per_token` describes a refusal that cannot
// happen, and would hand an operator the remedy for the other problem. The union
// makes it unrepresentable rather than merely never produced, and the JSON-Schema
// mirror carries the same `oneOf`/`const` pairing.
const ceilingUnenforceableBase = {
  refKind: z.string(),
  cli: z.string(),
  ceilingUsd: z.number().nonnegative(),
  detail: z.string(),
  remedy: z.string(),
};

export const CostCeilingUnenforceablePayload = z.discriminatedUnion("reason", [
  z
    .object({
      ...ceilingUnenforceableBase,
      reason: z.literal("harness_discards_generation_id"),
      billingMode: z.literal("per_token"),
    })
    .strict(),
  z
    .object({
      ...ceilingUnenforceableBase,
      reason: z.literal("byok_upstream_invoice"),
      billingMode: z.literal("per_token"),
    })
    .strict(),
  z
    .object({
      ...ceilingUnenforceableBase,
      reason: z.literal("unrecognized_credential_ref"),
      billingMode: z.literal("unattributed"),
    })
    .strict(),
]);

// cost.generation_id_missing — DRIFT DETECTION in the other direction: a route
// classified METERABLE made a real call that surfaced no generation id, so the
// per-call capture silently could not fire. Emitted once per run so a harness
// vocabulary change is LOUD rather than a quiet reversion to NULL cost.
export const CostGenerationIdMissingPayload = z
  .object({
    cli: z.string(),
    reason: z.string(),
  })
  .strict();

export const CostReconcileFailedPayload = z
  .object({
    basis: z.enum(["ccusage", "credits"]),
    totalCostUsd: z.number(),
    reason: z.enum(["no_rows", "zero_token_denominator"]),
    reasonText: z.string(),
  })
  .strict();
