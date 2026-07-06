/**
 * failure-recovery contracts the halted-run surface consumes from the
 * orchestrator recovery routes. Split out of `types.ts` (re-exported there) to
 * keep that file under the 500-line architecture cap. Local + minimal: only the
 * fields the recovery page + action proxies read.
 *
 * `RECOVERABLE_OUTCOMES` + `isRecoverableRun` are re-exported from
 * `@tanren/db` — the shared source-of-truth the orchestrator's
 * `assertRecoverable` gate also reads. Prior to this consolidation the two
 * copies drifted (the SPEC-LOOP REDESIGN added `convergence_stalled` to the
 * orchestrator's set but not this file), which mis-routed `convergence_stalled`
 * runs in the recovery UI. See `db/src/recoveryOutcomes.ts`.
 */

export { isRecoverableRun, RECOVERABLE_OUTCOMES } from "@tanren/db";

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
