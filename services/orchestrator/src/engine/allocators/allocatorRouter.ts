import type {
  AllocationRequest,
  Allocator,
  AllocatorTaxonomy,
  ReleaseReason,
  RunnerAllocation,
} from "../contracts/allocator.js";
import {
  type AllocatorKind,
  type AllocatorRoutingConfig,
  PoolCapacityExceededError,
  selectAllocatorKind,
} from "./poolPolicy.js";

/**
 * A registry mapping every allocator kind to a concrete {@link Allocator}.
 * Kinds the operator never routes to map to UnconfiguredAllocator stubs that
 * throw on use; this keeps the router total over the {@link AllocatorKind} enum
 * so routing can never pick a kind with no backing entry.
 */
export type AllocatorRegistry = Record<AllocatorKind, Allocator>;

/**
 * Strategy layer over the {@link Allocator} interface. Given a run's labels and
 * the project's routing config, it:
 *
 *  1. picks the allocator kind (label rules first-match, else default),
 *  2. enforces that kind's pool-policy `maxConcurrent` cap, and
 *  3. delegates `allocate` to the backing allocator for that kind.
 *
 * It tracks which kind each runner was allocated by so `release` decrements the
 * right pool counter and delegates to the right backing allocator — even
 * though release does not carry labels.
 *
 * The router is itself an {@link Allocator}, so it drops into every existing
 * call site (worker, hello workflow) unchanged.
 */
export class AllocatorRouter implements Allocator {
  // ROUTED: the router does not itself provision, lease, or delegate — each
  // allocate is dispatched to a backing allocator per the routing config, so
  // the CONCRETE lifecycle class varies per allocation. Consumers that need
  // the concrete class must consult `allocatorTaxonomyFor(kind)` on the kind
  // they know the runner was routed to.
  readonly taxonomy: AllocatorTaxonomy = "routed";
  /** In-flight runner count per kind, for pool-policy enforcement. */
  private readonly inFlight = new Map<AllocatorKind, number>();
  /** runnerId -> kind, so release routes to the same backing allocator. */
  private readonly runnerKinds = new Map<string, AllocatorKind>();

  constructor(
    private readonly registry: AllocatorRegistry,
    private readonly config: AllocatorRoutingConfig,
  ) {}

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const kind = selectAllocatorKind(this.config, request.labels ?? {});
    this.reserveCapacity(kind);

    const allocator = this.registry[kind];
    let allocation: RunnerAllocation;
    try {
      allocation = await allocator.allocate(request);
    } catch (error) {
      this.releaseCapacity(kind);
      throw error;
    }
    this.runnerKinds.set(allocation.runnerId, kind);
    return allocation;
  }

  async release(runnerId: string, reason?: ReleaseReason): Promise<void> {
    const kind = this.runnerKinds.get(runnerId);
    if (kind === undefined) {
      // Unknown to this router instance (e.g. process restart). We cannot know
      // which backing allocator owns it, so this is a no-op at the router
      // layer; the contract permits release of an unknown/already-released id.
      return;
    }
    this.runnerKinds.delete(runnerId);
    this.releaseCapacity(kind);
    await this.registry[kind].release(runnerId, reason);
  }

  /** Test/diagnostic helper: current in-flight count for a kind. */
  inFlightCount(kind: AllocatorKind): number {
    return this.inFlight.get(kind) ?? 0;
  }

  private reserveCapacity(kind: AllocatorKind): void {
    // #1254: an allocator that enforces its own cap in the SHARED store (manual_ssh)
    // is the sole cap authority — the router's in-memory counter is per-process and
    // would double-book across processes, so SKIP it and let the allocator's
    // cross-process reservation refuse an over-cap claim.
    if (this.registry[kind].enforcesOwnPoolCap === true) {
      return;
    }
    const policy = this.config.pools[kind];
    const current = this.inFlight.get(kind) ?? 0;
    if (policy?.maxConcurrent !== undefined && current >= policy.maxConcurrent) {
      throw new PoolCapacityExceededError(kind, policy.maxConcurrent);
    }
    this.inFlight.set(kind, current + 1);
  }

  private releaseCapacity(kind: AllocatorKind): void {
    // Mirror {@link reserveCapacity}: a self-enforcing kind never touched the
    // in-memory counter, so releasing it must not underflow it either.
    if (this.registry[kind].enforcesOwnPoolCap === true) {
      return;
    }
    const current = this.inFlight.get(kind) ?? 0;
    this.inFlight.set(kind, Math.max(0, current - 1));
  }
}
