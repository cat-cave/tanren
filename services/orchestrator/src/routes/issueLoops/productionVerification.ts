import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { ReleaseInstancesStore } from "../../engine/repositories/releaseInstances.js";
import { ResolutionJobStore } from "../../engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../../engine/repositories/symptomContracts.js";
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

/** Queue a locked production replay; bh-6b owns durable worker-stage execution. */
export function createProductionVerificationRoutes(options: ProductionVerificationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const contracts = options.contracts ?? new SymptomContractStore(options.pool);
  const enqueue = options.enqueue ?? new ResolutionJobStore(options.pool);
  const releaseById =
    options.releaseById ??
    ((orgId, releaseInstanceId) =>
      runWithOrgScope(options.pool, orgId, (client) =>
        ReleaseInstancesStore.getById(client, orgId, releaseInstanceId),
      ));
  const jobId = options.jobId ?? (() => `rjob_manual_production_${randomUUID()}`);

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
    return c.json(
      { version: "v1" as const, orgId, projectId, issueLoopId, resolutionJobId: queued.id, queued: queued.created },
      202,
    );
  });

  return app;
}
