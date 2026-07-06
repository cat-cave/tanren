// Shared source-of-truth for the `RECOVERABLE_OUTCOMES` policy set — the run
// outcomes that route a halted run to the failure-recovery surface. Consumed by
// BOTH the orchestrator (assertRecoverable / route guards in
// `services/orchestrator/src/engine/recovery/index.ts`) and the dashboard client
// helper (`services/dashboard/src/api/recoveryTypes.ts`).
//
// This file exists because the previous duplicated copies drifted: PR-#434
// (SPEC-LOOP REDESIGN) added `convergence_stalled` to the orchestrator's set
// but forgot the dashboard's copy, so a `convergence_stalled` run was rejected
// by the client-side `isRecoverableRun` classifier and the recovery UI
// mis-routed it (audit finding out of PR-#735). Unifying here makes horizontal
// drift architecturally impossible.
//
// This is a POLICY subset of the `RunOutcome` Zod enum in
// `services/orchestrator/src/engine/state/run.ts`; `stateTransitions.test.ts`
// asserts every value here is a valid `RunOutcome` option, so a rename or
// removal of the vocabulary trips the test rather than silently drifting.

/**
 * Ordered list of outcomes that route a halted run to the recovery surface.
 * The literal-string tuple lets the compiler narrow the derived `Set` element
 * type to the exact union.
 */
export const RECOVERABLE_OUTCOMES_LIST = [
  "halted",
  "escape_hatch_hit",
  "retry_budget_exhausted",
  // SPEC-LOOP REDESIGN: a convergence-stall halt is recoverable (rework the spec /
  // stronger model / fix the env, then re-run) — surfaced like the other halts.
  "convergence_stalled",
  "window_exhausted",
] as const;

/** Outcomes that route a run to the failure-recovery surface. */
export const RECOVERABLE_OUTCOMES: ReadonlySet<string> = new Set(RECOVERABLE_OUTCOMES_LIST);

/** True when a run's status/outcome routes it to the recovery surface. */
export function isRecoverableRun(run: { status: string; outcome: string | null }): boolean {
  return run.status === "halted" || RECOVERABLE_OUTCOMES.has(run.outcome ?? "");
}
