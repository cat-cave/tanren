/**
 * The merge-claim LEASE: how long a `merging` claim is considered fresh before it
 * is treated as STALE (a coordinator died mid-merge). Fresh claims survive so a
 * concurrent coordinate pass never double-drives an active merge; stale claims are
 * recovered back to `queued`.
 */
export const MERGE_CLAIM_LEASE_MS = 15 * 60 * 1000;
