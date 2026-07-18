// A coordinator re-observes an unchanged progress heartbeat at this cadence. It
// is not a total-operation deadline: only an absent ActivityWatchdog progress
// signal makes a claimed entry eligible for recovery.
export const MERGE_QUEUE_PROGRESS_RECHECK_MS = 1_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function serializedRetryAfterMs(_snapshot?: unknown): number {
  return MERGE_QUEUE_PROGRESS_RECHECK_MS;
}

export function boundedRetryDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_NODE_TIMER_DELAY_MS;
  return Math.min(MAX_NODE_TIMER_DELAY_MS, Math.max(1, Math.ceil(delayMs)));
}
