// The SINGLE SOURCE OF TRUTH for the merge-coordinator retry/backoff schedule.
//
// The same two magic numbers — the recoverable-drive backoff curve and the
// post-alert re-drive delay — were previously re-declared across
// `recoverableDriveHold.ts`, `batchInfraHoldCeiling.ts`, and `coordinator.ts`. A
// drift between them (e.g. one path backing off 60s, another still hot-looping at
// 3s) is exactly the kind of runaway the ceilings exist to prevent. They are
// consolidated here; every merge backoff imports from this module. A grep test
// (`retrySchedule.test.ts`) FAILS if a `60_000` or the schedule literal is
// re-defined anywhere in `engine/merge/*` outside this file.

/**
 * The bounded backoff curve for a RECOVERABLE merge-drive hold: each consecutive
 * hold of the same candidate waits the next (longer) delay, then clamps to the last
 * entry. After the curve is exhausted the candidate hits its attempt ceiling and the
 * loud alert fires. Indexed by `attempt - 1`, clamped to the final element.
 */
export const RECOVERABLE_RETRY_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000, 60_000];

/**
 * How long after a TERMINAL ceiling alert the subscriber waits before the next
 * autonomous re-drive. Longer than the recoverable curve so a persistent outage (or
 * a logic-bug masquerading as infra) cannot hot-loop while still recovering on its
 * own. The single value behind every "after the alert, back off this long" path
 * (recoverable-drive ceiling, batch consecutive-infra ceiling, transient-drive ceiling).
 */
export const alertRetryAfterMs = 60_000;

/**
 * Pick the recoverable backoff for a 1-based attempt count, clamped to the last
 * element of {@link RECOVERABLE_RETRY_DELAYS_MS}.
 */
export function recoverableRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt - 1, 0), RECOVERABLE_RETRY_DELAYS_MS.length - 1);
  return RECOVERABLE_RETRY_DELAYS_MS[index] ?? alertRetryAfterMs;
}
