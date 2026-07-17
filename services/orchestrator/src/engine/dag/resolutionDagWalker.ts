import type { ResolutionStage, ResolutionStageKind } from "../contracts/resolutionStage.js";
import { DEFAULT_RESOLUTION_JOB_LEASE_MS, type ResolutionJobStore } from "../repositories/resolutionJobs.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("resolution-dag-walker");

// bh-6a intentionally registers no stages. bh-8 and bh-10 add implementations;
// bh-6b wires the stage transitions around this durable claim/lease loop.
const registeredStages = new Map<ResolutionStageKind, ResolutionStage>();

export interface ResolutionDagWalkerDeps {
  readonly store: ResolutionJobStore;
  /** System-scoped enumeration belongs to the caller; all store operations remain org-scoped. */
  readonly orgIds: () => Promise<readonly string[]>;
  readonly leaseOwner: string;
  readonly leaseMs?: number;
}

export interface ResolutionDagWalkerOptions {
  readonly scanIntervalMs?: number;
}

export interface ResolutionDagWalkResult {
  readonly orgId: string;
  readonly recoveredJobIds: readonly string[];
  readonly claimedJobIds: readonly string[];
}

/**
 * The durable resolution walker skeleton. It scans immediately at startup and
 * periodically thereafter. There is deliberately no stage execution in bh-6a:
 * every leased job is heartbeated once and released back to the ready set.
 */
export class ResolutionDagWalker {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;
  private readonly scanIntervalMs: number;
  private readonly leaseMs: number;

  public constructor(
    private readonly deps: ResolutionDagWalkerDeps,
    options: ResolutionDagWalkerOptions = {},
  ) {
    this.scanIntervalMs = Math.max(1, options.scanIntervalMs ?? 30_000);
    this.leaseMs = deps.leaseMs ?? DEFAULT_RESOLUTION_JOB_LEASE_MS;
  }

  public start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.scanIntervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one durable scan. A concurrent timer tick is harmlessly ignored. */
  public async tick(): Promise<ResolutionDagWalkResult[]> {
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      const orgIds = await this.deps.orgIds();
      const results: ResolutionDagWalkResult[] = [];
      for (const orgId of orgIds) {
        if (this.stopped) break;
        results.push(await this.walkOrg(orgId));
      }
      return results;
    } catch (error) {
      log.error("resolution scan failed; next periodic scan retries", {}, error);
      return [];
    } finally {
      this.ticking = false;
    }
  }

  private async walkOrg(orgId: string): Promise<ResolutionDagWalkResult> {
    const claim = { orgId, leaseOwner: this.deps.leaseOwner, leaseMs: this.leaseMs };
    const recovered = await this.deps.store.recoverExpiredLeases(claim);
    const recoveredJobIds = recovered.map((job) => job.id);

    // A recovered lease is already running, so process it before selecting fresh
    // work. This avoids re-claiming its just-released row within the same scan.
    if (recovered.length > 0) {
      for (const job of recovered) await this.placeholder(job.id, claim);
      return { orgId, recoveredJobIds, claimedJobIds: [] };
    }

    const next = await this.deps.store.claimNext(claim);
    if (next === undefined) return { orgId, recoveredJobIds, claimedJobIds: [] };
    await this.placeholder(next.id, claim);
    return { orgId, recoveredJobIds, claimedJobIds: [next.id] };
  }

  private async placeholder(
    jobId: string,
    claim: { orgId: string; leaseOwner: string; leaseMs: number },
  ): Promise<void> {
    // This is the bh-6a placeholder in place of a future registered stage. It
    // intentionally exercises heartbeat ownership before returning the lease.
    await this.deps.store.heartbeat({ ...claim, id: jobId });
    await this.deps.store.release({ orgId: claim.orgId, id: jobId, leaseOwner: claim.leaseOwner });
  }
}

export { registeredStages };
