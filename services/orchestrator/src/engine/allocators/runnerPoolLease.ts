// SHARED-STORE fixed-pool lease reservation seam (#1254 / hazard C). The types +
// errors + interface live here (kept out of `runnerStore.ts` for the file-line
// cap); `PgRunnerStore` implements the interface and re-exports these symbols so
// consumers keep a single `runnerStore.js` import.

/**
 * A single candidate target the {@link RunnerPoolLeaseStore} may lease for a
 * fixed-pool allocation (one pre-provisioned manual-ssh host). The store picks
 * the first candidate not already held by a LIVE lease and writes its reach
 * fields onto the `runners` row.
 */
export interface PoolLeaseCandidate {
  /** The stable pool-lease key (the manual-ssh host id). At most one LIVE lease per (org, leaseKey). */
  leaseKey: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  containerId: string;
}

export interface ReservePoolLeaseInput {
  runnerId: string;
  runId: string | null;
  projectId: string | null;
  orgId: string | null;
  allocator: string;
  /** The cap bucket — the count of LIVE rows sharing it is what `maxConcurrent` bounds. */
  poolKey: string;
  /** The claiming allocator instance's identity, stamped as the fencing owner. */
  owner: string;
  /** Cross-process cap; a reservation that would exceed it is refused. Omit for unbounded (bounded by candidate count). */
  maxConcurrent?: number;
  imageSha: string;
  /** Candidate targets, in preference (round-robin) order; the first free one is leased. */
  candidates: ReadonlyArray<PoolLeaseCandidate>;
}

export interface PoolLeaseReservation {
  leaseKey: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  containerId: string;
  owner: string;
  /** The stamped monotonic fencing token (bigint as string), or `null` if the DB did not return one (test fakes). */
  fencingToken: string | null;
}

export interface ReleasePoolLeaseInput {
  runnerId: string;
  owner: string;
  fencingToken: string | null;
}

export interface PoolLeaseReleaseOutcome {
  /** True when this call transitioned a LIVE lease to released; false when it was already released / absent (a no-op). */
  released: boolean;
}

/**
 * Thrown by {@link RunnerPoolLeaseStore.reservePoolLease} when the pool already
 * holds `maxConcurrent` LIVE leases — the cap is enforced ATOMICALLY (inside the
 * advisory-lock-serialized reservation), so a concurrent reserver on another
 * process cannot slip a claim past the cap.
 */
export class PoolLeaseCapacityError extends Error {
  readonly retriable = false as const;
  constructor(
    readonly poolKey: string,
    readonly maxConcurrent: number,
  ) {
    super(`runner pool '${poolKey}' at capacity: ${maxConcurrent} concurrent lease(s) held`);
    this.name = "PoolLeaseCapacityError";
  }
}

/**
 * Thrown when every candidate target already carries a LIVE lease — the pool is
 * exhausted (all hosts busy). Distinct from {@link PoolLeaseCapacityError}: here
 * the numeric cap (if any) was not reached but no free host remains.
 */
export class PoolLeaseExhaustedError extends Error {
  readonly retriable = false as const;
  constructor(
    readonly poolKey: string,
    readonly candidateCount: number,
  ) {
    super(`runner pool '${poolKey}' exhausted: all ${candidateCount} candidate host(s) are leased`);
    this.name = "PoolLeaseExhaustedError";
  }
}

/**
 * Thrown by {@link RunnerPoolLeaseStore.releasePoolLease} when a LIVE lease exists
 * for the runner id but its `lease_owner` / `fencing_token` do NOT match the
 * caller's — i.e. the caller is a STALE holder whose lease was already released
 * and re-claimed by another owner. Fencing rejects the overwrite rather than
 * silently freeing the new holder's lease.
 */
export class StaleLeaseReleaseError extends Error {
  readonly retriable = false as const;
  constructor(readonly runnerId: string) {
    super(
      `refusing to release runner ${runnerId}: the LIVE lease is held by a different owner/fencing token (stale release)`,
    );
    this.name = "StaleLeaseReleaseError";
  }
}

/**
 * The SHARED-STORE reservation seam for FIXED-POOL allocators (#1254 / hazard C).
 * The pre-#1254 manual-ssh allocator tracked busy hosts + the `maxConcurrent` cap
 * in IN-MEMORY, per-process maps, so two orchestrator processes on one host each
 * counted only their own leases and double-booked a runner / overran the cap. This
 * seam moves both onto the `runners` table so the reservation is a genuine atomic
 * cross-process DB operation.
 */
export interface RunnerPoolLeaseStore {
  /**
   * Atomically lease one free candidate for a fixed pool, enforcing `maxConcurrent`
   * across every process. Serialized per (org, poolKey) by a Postgres advisory
   * transaction lock (auto-released at COMMIT — no wall-clock deadline), backstopped
   * by the `runners_live_lease_key_uniq` partial unique index. Throws
   * {@link PoolLeaseCapacityError} if the cap is reached, {@link PoolLeaseExhaustedError}
   * if no free candidate remains, `RunnerClaimLiveRowError` if the runner id already
   * has a LIVE row.
   */
  reservePoolLease(input: ReservePoolLeaseInput): Promise<PoolLeaseReservation>;
  /**
   * Release a lease this owner holds. Requires the caller's `owner` + `fencingToken`
   * to match the LIVE row; a non-matching LIVE lease throws {@link StaleLeaseReleaseError}
   * (fencing), while an already-released / absent row is a no-op (`released: false`).
   */
  releasePoolLease(input: ReleasePoolLeaseInput): Promise<PoolLeaseReleaseOutcome>;
}
