import { MERGE_CLAIM_LEASE_MS } from "./mergeClaimLease.js";

const SERIALIZED_RETRY_BUFFER_MS = 1_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function serializedRetryAfterMs(snapshot: { serializedRetryAfterMs?: number }): number {
  return boundedRetryDelayMs((snapshot.serializedRetryAfterMs ?? MERGE_CLAIM_LEASE_MS) + SERIALIZED_RETRY_BUFFER_MS);
}

export function parseSerializedRetryAfterMs(value: string | null | undefined): number | undefined {
  const parsed = value === null || value === undefined ? undefined : Number(value);
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

export function boundedRetryDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_NODE_TIMER_DELAY_MS;
  return Math.min(MAX_NODE_TIMER_DELAY_MS, Math.max(1, Math.ceil(delayMs)));
}
