// A wake cadence, not a lease deadline. It merely gives a coordinator another
// opportunity to observe a released liveness fence after a crash; a live fence
// continues to win indefinitely.
const MERGE_QUEUE_REDRIVE_CADENCE_MS = 1_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function serializedRetryAfterMs(_snapshot?: unknown): number {
  return MERGE_QUEUE_REDRIVE_CADENCE_MS;
}

export function boundedRetryDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_NODE_TIMER_DELAY_MS;
  return Math.min(MAX_NODE_TIMER_DELAY_MS, Math.max(1, Math.ceil(delayMs)));
}
