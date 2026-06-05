/**
 * failure-recovery contracts the halted-run surface consumes from the
 * orchestrator recovery routes. Split out of `types.ts` (re-exported there) to
 * keep that file under the 500-line architecture cap. Local + minimal: only the
 * fields the recovery page + action proxies read.
 */

/**
 * Recovery context for a halted run (`GET .../runs/:runId/recovery`). Drives
 * the halted-run page: which cards are enabled (rollback needs a prior commit)
 * and the failure-context cells.
 */
export interface RecoveryContext {
  runId: string;
  specId: string;
  projectId: string;
  status: string;
  outcome: string | null;
  /** Last good commit SHA, or null when none was captured (rollback disabled). */
  lastGoodCommit: string | null;
}

/** Result envelope returned by every recovery action endpoint. */
export interface RecoveryActionResult<T = Record<string, unknown>> {
  ok: boolean;
  result?: T;
  error?: string;
  message?: string;
}

/** Outcomes that route a run to the failure-recovery surface. */
export const RECOVERABLE_OUTCOMES = new Set([
  "halted",
  "escape_hatch_hit",
  "retry_budget_exhausted",
  "window_exhausted",
]);

/** True when a run's status/outcome routes it to the recovery surface. */
export function isRecoverableRun(run: { status: string; outcome: string | null }): boolean {
  return run.status === "halted" || RECOVERABLE_OUTCOMES.has(run.outcome ?? "");
}
