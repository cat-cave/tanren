import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { ResolutionJobStore } from "../../engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../../engine/repositories/symptomContracts.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

const steerSchema = z
  .object({
    contractId: z.string().min(1).max(256),
    stage: z.enum(["baseline", "production", "counterfactual", "soak"]),
    releaseInstanceId: z.string().min(1).max(256).optional(),
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();

type RouteContext = Context<ActorContextEnv>;

export interface IssueLoopCommandRoutesOptions {
  readonly pool: pg.Pool;
  readonly jobs?: Pick<ResolutionJobStore, "enqueue" | "pauseLoop" | "resumeLoop">;
  readonly contracts?: Pick<SymptomContractStore, "get">;
  readonly jobId?: () => string;
}

function requireActor(c: RouteContext): ActorContext {
  const actor = c.var.actor;
  if (actor === undefined) throw new Error("actor missing on context");
  return actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) throw new Error(`route parameter ${name} missing`);
  return value;
}

function authorize(c: RouteContext): { orgId: string; projectId: string; loopId: string } | Response {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  const projectId = requireParam(c, "projectId");
  const loopId = requireParam(c, "loopId");
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
  return { orgId, projectId, loopId };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/** Admin command surface for steering and pausing/resuming durable loop jobs. */
export function createIssueLoopCommandRoutes(options: IssueLoopCommandRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const jobs = options.jobs ?? new ResolutionJobStore(options.pool);
  const contracts = options.contracts ?? new SymptomContractStore(options.pool);
  const jobId = options.jobId ?? (() => `rjob_steered_${randomUUID()}`);

  app.post("/:orgId/projects/:projectId/issue-loops/:loopId/steer", async (c) => {
    const scope = authorize(c);
    if (isResponse(scope)) return scope;
    const parsed = steerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_resolution_steer", issues: parsed.error.issues }, 400);
    const contract = await contracts.get(scope.orgId, parsed.data.contractId);
    if (contract === undefined || contract.projectId !== scope.projectId || contract.issueLoopId !== scope.loopId) {
      return c.json({ error: "symptom_contract_not_found" }, 404);
    }
    const queued = await jobs.enqueue({
      orgId: scope.orgId,
      projectId: scope.projectId,
      id: jobId(),
      issueLoopId: scope.loopId,
      contractId: contract.id,
      ...(parsed.data.releaseInstanceId === undefined ? {} : { releaseInstanceId: parsed.data.releaseInstanceId }),
      stage: parsed.data.stage,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return c.json({ version: "v1" as const, ...scope, resolutionJobId: queued.id, queued: queued.created }, 202);
  });

  app.post("/:orgId/projects/:projectId/issue-loops/:loopId/pause", async (c) => {
    const scope = authorize(c);
    if (isResponse(scope)) return scope;
    const paused = await jobs.pauseLoop({ orgId: scope.orgId, projectId: scope.projectId, issueLoopId: scope.loopId });
    return c.json({ version: "v1" as const, ...scope, paused });
  });

  app.post("/:orgId/projects/:projectId/issue-loops/:loopId/resume", async (c) => {
    const scope = authorize(c);
    if (isResponse(scope)) return scope;
    const resumed = await jobs.resumeLoop({
      orgId: scope.orgId,
      projectId: scope.projectId,
      issueLoopId: scope.loopId,
    });
    return c.json({ version: "v1" as const, ...scope, resumed });
  });

  return app;
}
