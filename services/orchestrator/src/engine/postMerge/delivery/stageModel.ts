// The durable post-merge delivery DAG stage model (integrations.md §F "Preserve
// MergeAuthority and turn landing into release activation" + the Target-lifecycle
// diagram).
//
// in-17 replaces the old FIXED subscriber chain (issue → deploy → demo, catch-and-log
// isolation, [subscriber.ts]) with a durable, RESUMABLE delivery DAG driven off the
// in-16 `delivery_runs` transactional outbox row. The land transaction already inserted
// exactly one `delivery_runs` row (pending) atomically with `merge.completed`; NO
// external provider call happens until the delivery DAG runs, strictly AFTER that
// commit. MergeAuthority stays the SOLE land decision — this DAG never lands code.
//
// The stage set + ordinals are FROZEN by migration 0043's `delivery_stage_attempts`
// stage enum. Each stage persists its attempt to `delivery_stage_attempts` (org-scoped)
// so a crash mid-DAG resumes from the last durable SUCCEEDED stage — never re-running a
// committed external effect, never discarding progress. Runtime binding MUST precede
// deploy (the ordinal order enforces bind → deploy → verify → observe → evidence).

/** The nine delivery stages, in dependency order. IDENTICAL to migration 0043's enum. */
export const DELIVERY_STAGES = [
  "reconcile_binding",
  "mint_lease",
  "materialize_env",
  "attach_runtime",
  "deploy",
  "verify_deploy",
  "stimulate",
  "observe",
  "record_evidence",
] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

/** The 0-based ordinal of a stage (its position in {@link DELIVERY_STAGES}). */
export function stageOrdinal(stage: DeliveryStage): number {
  return DELIVERY_STAGES.indexOf(stage);
}

/**
 * The outcome a stage executor returns. There is NO "assumed success": a stage
 * advances the DAG ONLY on `confirmed` (its external effect was OBSERVED, or the
 * stage is a legitimate no-op for this project). `degraded` is an explicit durable
 * non-terminal state — the effect could not be confirmed (unconfirmable / errored /
 * still in flight); the DAG STOPS at this stage and resumes it on the next wake. A
 * stage NEVER silently reports success.
 */
export type StageOutcome =
  | { readonly kind: "confirmed" }
  | { readonly kind: "degraded"; readonly classification: string; readonly detail: string };

export const confirmed: StageOutcome = { kind: "confirmed" };

export function degraded(classification: string, detail: string): StageOutcome {
  return { kind: "degraded", classification, detail };
}

/**
 * The durable delivery-run state machine (migration 0043 `delivery_runs.status`).
 * `pending` is the outbox seed; the driver claims it into `running`; it settles into
 * `completed` (all stages confirmed + signed evidence recorded), `degraded` (a stage
 * could not confirm — durable, resumable on the next wake), or `needs_attention` (an
 * unexpected driver-level failure). `completed` is the ONLY terminal-success state and
 * is reached ONLY through the record_evidence stage's fail-closed gate.
 */
export type DeliveryRunStatus = "pending" | "claimed" | "running" | "completed" | "degraded" | "needs_attention";

/** The immutable coordinates a delivery drives against (resolved once per drive). */
export interface DeliveryLineage {
  readonly runId: string;
  readonly specId: string;
  readonly projectId: string;
  readonly orgId: string;
  /** The merged commit SHA the delivery activates (from `merge.completed`). */
  readonly mergeSha: string;
}
