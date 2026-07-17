import type { ResolutionJob, ResolutionStage, ResolutionStageKind } from "../contracts/resolutionStage.js";
import type { ResolutionAuthority } from "../contracts/resolutionAuthority.js";
import { DEFAULT_RESOLUTION_JOB_LEASE_MS, type ResolutionJobStore } from "../repositories/resolutionJobs.js";
import type { RepairRouter } from "../workflow/repairRouting.js";
import { createLogger } from "../observability/logger.js";
import { authorizeProductionResolution } from "./productionResolutionAuthorization.js";
import { settleResolutionJob } from "./resolutionJobSettlement.js";

const log = createLogger("resolution-dag-walker");

type LeaseClaim = {
  readonly orgId: string;
  readonly leaseOwner: string;
  readonly leaseMs: number;
};

export interface ResolutionDagWalkerDeps {
  readonly store: ResolutionJobStore;
  /** System-scoped enumeration belongs to the caller; all store operations remain org-scoped. */
  readonly orgIds: () => Promise<readonly string[]>;
  /** The production registry from `resolutionStages/index.ts`, keyed by job stage. */
  readonly stages: ReadonlyMap<ResolutionStageKind, ResolutionStage>;
  readonly leaseOwner: string;
  readonly leaseMs?: number;
  /** Required whenever a production stage is registered; absent authority fails closed. */
  readonly authority?: ResolutionAuthority;
  /** Required for a blocked production decision; absent routing fails closed. */
  readonly repairRouter?: RepairRouter;
}

export interface ResolutionDagWalkerOptions {
  readonly scanIntervalMs?: number;
}

export interface ResolutionDagWalkResult {
  readonly orgId: string;
  readonly recoveredJobIds: readonly string[];
  readonly claimedJobIds: readonly string[];
}

class ResolutionLeaseLostError extends Error {
  public override readonly name = "ResolutionLeaseLostError";
}

/**
 * Durable claim → fence → run → settle orchestration for resolution stages.
 *
 * A notification can reduce latency, but this periodic scan is the source of
 * truth: every claimed/recovered row is re-fenced immediately before invoking a
 * stage, heartbeated while that stage is running, and settled only through the
 * same unexpired lease. A completed row is never claimable again.
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
    const claim: LeaseClaim = { orgId, leaseOwner: this.deps.leaseOwner, leaseMs: this.leaseMs };
    const recovered = await this.deps.store.recoverExpiredLeases(claim);
    for (const job of recovered) await this.runClaimed(job, claim);

    // Recovery rows stay running under this worker's fresh lease. After handling
    // them, also take one normal queued row so a dropped notification only affects
    // latency, never whether work is eventually driven.
    const next = await this.deps.store.claimNext(claim);
    if (next !== undefined) await this.runClaimed(next, claim);
    return {
      orgId,
      recoveredJobIds: recovered.map((job) => job.id),
      claimedJobIds: next === undefined ? [] : [next.id],
    };
  }

  private async runClaimed(claimed: ResolutionJob, claim: LeaseClaim): Promise<void> {
    // The claim result is not itself authority to execute: re-read and extend the
    // active lease to protect against an expiry/reclaim between claim and run.
    const job = await this.deps.store.verifyActiveLease({ ...claim, id: claimed.id });
    if (job === undefined) {
      throw new ResolutionLeaseLostError(`resolution job ${claimed.id} no longer has this worker's active lease`);
    }
    const stage = this.deps.stages.get(job.stage);
    if (stage === undefined) {
      await this.releaseAfterStageFailure(job, claim, new Error(`resolution stage ${job.stage} is not registered`));
      return;
    }

    const heartbeatEveryMs = Math.max(1, Math.floor(claim.leaseMs / 3));
    let stopped = false;
    let heartbeatError: Error | undefined;
    let heartbeatInFlight: Promise<void> = Promise.resolve();
    const heartbeat = (): void => {
      heartbeatInFlight = heartbeatInFlight
        .then(async () => {
          if (stopped) return;
          const renewed = await this.deps.store.heartbeat({ ...claim, id: job.id });
          if (!renewed) {
            throw new ResolutionLeaseLostError(`resolution job ${job.id} lost its lease while ${job.stage} ran`);
          }
        })
        .catch((error: unknown) => {
          heartbeatError = asError(error);
        });
    };
    const timer = setInterval(heartbeat, heartbeatEveryMs);
    timer.unref?.();

    try {
      const result = await stage.run(job, {});
      stopped = true;
      clearInterval(timer);
      await heartbeatInFlight;
      if (heartbeatError !== undefined) throw asError(heartbeatError);

      // `ProductionSymptomStage.run` has already durably settled its verification
      // run + assertions before it returns. Its product_resolved result is still
      // only evidence: the separate ResolutionAuthority is the sole component
      // allowed to declare an internal resolution / source-closure eligibility.
      await authorizeProductionResolution(this.deps.authority, job, this.deps.repairRouter);

      const settled = await settleResolutionJob(this.deps.store, job, result);
      if (!settled) {
        throw new ResolutionLeaseLostError(`resolution job ${job.id} lost its lease before result settlement`);
      }
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      await this.releaseAfterStageFailure(job, claim, error);
    }
  }

  private async releaseAfterStageFailure(job: ResolutionJob, claim: LeaseClaim, error: unknown): Promise<never> {
    const released = await this.deps.store.release({ ...claim, id: job.id, state: "retryable" });
    if (!released) {
      throw new Error(`resolution job ${job.id} failed and could not be released under its lease`, { cause: error });
    }
    throw asError(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
