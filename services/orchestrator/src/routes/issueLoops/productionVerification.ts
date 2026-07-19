import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type {
  ResolutionStage,
  ResolutionStageKind,
  ResolutionStageResult,
} from "../../engine/contracts/resolutionStage.js";
import type { ResolutionAuthority } from "../../engine/contracts/resolutionAuthority.js";
import {
  applyReproofDeployOutcome,
  authorizeProductionResolution,
  buildPostMergeBehaviorAcceptanceVerifier,
  buildPostMergeReproofCoordinator,
  buildProductionRepairRouter,
  buildRegressionBisector,
  recordPostMergeBehaviorVerdict,
  recordRegressionBisections,
  type PostMergeBehaviorAcceptanceVerifier,
  type PostMergeReproofCoordinator,
  type RegressionBisector,
  type RepairRouter,
} from "../../engine/dag/productionResolutionAuthorization.js";
import { ReleaseInstancesStore } from "../../engine/repositories/releaseInstances.js";
import { ResolutionJobStore } from "../../engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../../engine/repositories/symptomContracts.js";
import { settleResolutionJob } from "../../engine/dag/resolutionJobSettlement.js";
import { buildResolutionAuthority } from "../../engine/governance/resolutionAuthority.js";
import { createResolutionStageRegistry } from "../../engine/verification/resolutionStages/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

const RetryVerificationBody = z
  .object({
    contractId: z.string().min(1).max(256),
    releaseInstanceId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();

type RouteContext = Context<ActorContextEnv>;

export interface ProductionVerificationRoutesOptions {
  readonly pool: pg.Pool;
  readonly contracts?: Pick<SymptomContractStore, "get">;
  readonly enqueue?: Pick<ResolutionJobStore, "enqueue">;
  readonly jobs?: Pick<ResolutionJobStore, "claimById" | "verifyActiveLease" | "complete" | "release">;
  /** Required for the production decision; the default is the live authority. */
  readonly authority?: Pick<ResolutionAuthority, "authorize">;
  /** Required for blocked decisions; defaults to the live deterministic router. */
  readonly repairRouter?: RepairRouter;
  /**
   * rv-19 deploy-side settlement of the operator-retry production verdict — promotes a
   * `product_resolved` re-proof or rolls the live release pointer back on a
   * `product_failure`. Defaults to the live coordinator so this manual path can NEVER
   * complete a `product_failure` with the broken release left live (the walker's guarantee).
   */
  readonly reproofCoordinator?: Pick<PostMergeReproofCoordinator, "settle">;
  /**
   * rv-16a persisted post-merge PRODUCTION behavior verdict for the operator-retry path —
   * records the run's declared behaviors' rv-11 acceptance against the live release. Defaults
   * to the live verifier so a manual retry ALSO persists the real production behavior verdict.
   */
  readonly behaviorVerifier?: Pick<PostMergeBehaviorAcceptanceVerifier, "verify">;
  /**
   * rv-16b behavior-aware regression bisector for the operator-retry path — localizes the
   * culprit deployed release when the re-recorded post-merge verdict regressed. Best-effort;
   * defaults to the live bisector.
   */
  readonly regressionBisector?: Pick<RegressionBisector, "bisect">;
  readonly stages?: ReadonlyMap<ResolutionStageKind, ResolutionStage>;
  readonly releaseById?: (
    orgId: string,
    releaseInstanceId: string,
  ) => Promise<
    | {
        readonly projectId: string;
        readonly environment: string;
        readonly state: string;
      }
    | undefined
  >;
  readonly jobId?: () => string;
  readonly executionLeaseOwner?: () => string;
}

function actor(c: RouteContext): ActorContext {
  const value = c.var.actor;
  if (value === undefined) throw new Error("actor missing on context");
  return value;
}

function param(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) throw new Error(`route parameter ${name} missing`);
  return value;
}

/** Execute a locked production replay now while retaining its durable job receipt. */
export function createProductionVerificationRoutes(options: ProductionVerificationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const contracts = options.contracts ?? new SymptomContractStore(options.pool);
  const enqueue = options.enqueue ?? new ResolutionJobStore(options.pool);
  const jobs = options.jobs ?? new ResolutionJobStore(options.pool);
  const authority = options.authority ?? buildResolutionAuthority(options.pool);
  const repairRouter = options.repairRouter ?? buildProductionRepairRouter(options.pool);
  const reproofCoordinator = options.reproofCoordinator ?? buildPostMergeReproofCoordinator(options.pool);
  const behaviorVerifier = options.behaviorVerifier ?? buildPostMergeBehaviorAcceptanceVerifier(options.pool);
  const regressionBisector = options.regressionBisector ?? buildRegressionBisector(options.pool);
  const stages = options.stages ?? createResolutionStageRegistry({ pool: options.pool });
  const stage = stages.get("production");
  if (stage === undefined) throw new Error("production resolution stage is not registered");
  const releaseById =
    options.releaseById ??
    ((orgId, releaseInstanceId) =>
      runWithOrgScope(options.pool, orgId, (client) =>
        ReleaseInstancesStore.getById(client, orgId, releaseInstanceId),
      ));
  const jobId = options.jobId ?? (() => `rjob_manual_production_${randomUUID()}`);
  const executionLeaseOwner = options.executionLeaseOwner ?? (() => `route-production-${randomUUID()}`);

  app.post("/:orgId/projects/:projectId/issue-loops/:loopId/retry-verification", async (c) => {
    const requestActor = actor(c);
    const orgId = param(c, "orgId");
    const projectId = param(c, "projectId");
    const issueLoopId = param(c, "loopId");
    if (!actorCanAccessOrg(requestActor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    if (!actorIsOrgAdmin(requestActor, orgId)) return c.json({ error: "org_admin_required" }, 403);

    const parsed = RetryVerificationBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_retry_verification", issues: parsed.error.issues }, 400);

    const [contract, release] = await Promise.all([
      contracts.get(orgId, parsed.data.contractId),
      releaseById(orgId, parsed.data.releaseInstanceId),
    ]);
    if (contract === undefined || contract.projectId !== projectId || contract.issueLoopId !== issueLoopId) {
      return c.json({ error: "symptom_contract_not_found" }, 404);
    }
    if (release === undefined || release.projectId !== projectId)
      return c.json({ error: "release_instance_not_found" }, 404);
    if (release.environment !== "production" || release.state !== "live") {
      return c.json({ error: "release_instance_not_live" }, 409);
    }

    const queued = await enqueue.enqueue({
      orgId,
      projectId,
      id: jobId(),
      issueLoopId,
      contractId: contract.id,
      releaseInstanceId: parsed.data.releaseInstanceId,
      stage: "production",
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const claimed = await jobs.claimById({ orgId, id: queued.id, leaseOwner: executionLeaseOwner() });
    if (claimed === undefined) {
      return c.json({ error: "production_verification_not_claimable", resolutionJobId: queued.id }, 409);
    }
    // A synchronous claim is still not enough authority to invoke the stage: a
    // lease can expire or be recovered between the claim and external probe.
    const job = await jobs.verifyActiveLease({
      orgId,
      id: claimed.id,
      leaseOwner: claimed.leaseOwner,
    });
    if (job === undefined) {
      return c.json({ error: "production_verification_lease_not_active", resolutionJobId: queued.id }, 423);
    }
    let verdict: ResolutionStageResult;
    try {
      verdict = await stage.run(job, { source: "operator_retry" });
    } catch (error) {
      await jobs.release({ orgId, id: job.id, leaseOwner: job.leaseOwner, state: "retryable" });
      throw error;
    }
    try {
      // Keep the direct operator retry on the walker’s sole-decision path. The
      // stage has written immutable production evidence, but this lease must not
      // become completed until the authority records its decision and event.
      await authorizeProductionResolution(authority, job, repairRouter);
      // rv-16a: persist the post-merge PRODUCTION behavior verdict against the still-live
      // release BEFORE the deploy decision (same ordering + guarantee as the walker path).
      const behaviorResult = await recordPostMergeBehaviorVerdict(behaviorVerifier, job);
      // rv-19: the SAME deploy-side settlement the walker applies — promote the proven
      // release, or roll the live pointer back on a product_failure. Without it this
      // manual retry path would complete a failed re-proof with the broken release LIVE.
      await applyReproofDeployOutcome(reproofCoordinator, job, verdict);
      // rv-16b: best-effort regression bisection off a regressed post-merge verdict (diagnostic;
      // never blocks settlement — a failure is swallowed so the manual retry still completes).
      try {
        await recordRegressionBisections(regressionBisector, behaviorResult, job);
      } catch {
        /* diagnostic only; the bisector itself fails closed to an inconclusive record */
      }
    } catch (error) {
      await jobs.release({ orgId, id: job.id, leaseOwner: job.leaseOwner, state: "retryable" });
      throw error;
    }
    if (!(await settleResolutionJob(jobs, job, verdict))) {
      throw new Error(`production verification job ${job.id} lost its lease before result settlement`);
    }
    return c.json(
      {
        version: "v1" as const,
        orgId,
        projectId,
        issueLoopId,
        resolutionJobId: queued.id,
        queued: queued.created,
        verdict,
      },
      200,
    );
  });

  return app;
}
