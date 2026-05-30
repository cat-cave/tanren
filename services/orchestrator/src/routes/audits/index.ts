// P3-0021 scheduled-audits HTTP routes.
//
//   GET  /:orgId/audits                      → { jobs, recommended }
//   POST /:orgId/audits                       create an audit job (the composer)
//   POST /:orgId/audits/:jobId/enable         enable the job
//   POST /:orgId/audits/:jobId/disable        pause the job
//   POST /:orgId/audits/:jobId/run            run the read-only pass now →
//                                             findings auto-route to the inbox
//
// The pass runner is injectable (`passRunner`) and defaults to the safe no-op
// runner, so the endpoint is live without SSH/provider infra. Mounted on the
// shared `/orgs` base. Findings emitted by a run land in the candidate inbox
// (P3-0022) via the scheduler's system-source auto-route — this route never
// forks the inbox.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  AuditCadence,
  AuditKind,
  createAuditJob,
  createNoopPassRunner,
  getAuditJob,
  listAuditJobs,
  recommendCoverage,
  runAuditJob,
  setAuditJobEnabled,
  type AuditPassRunner,
  type AuditSchedulerDeps,
} from "../../engine/forge/audits/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface AuditRoutesOptions {
  pool: pg.Pool;
  // Injectable read-only pass executor (SSH/Answerer-backed in prod; a fake in
  // tests). Defaults to the safe no-op runner.
  passRunner?: AuditPassRunner;
}

const CreateJobBody = z
  .object({
    kind: AuditKind,
    name: z.string().min(1).max(120),
    cadence: AuditCadence,
    projectId: z.string().min(1).nullable().default(null),
    targetWindow: z.string().max(120).default(""),
    answererCli: z.string().max(120).default(""),
    enabled: z.boolean().default(true),
  })
  .strict();

export function createAuditRoutes(options: AuditRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const schedulerDeps: AuditSchedulerDeps = {
    pool: options.pool,
    passRunner: options.passRunner ?? createNoopPassRunner(),
  };

  app.get("/:orgId/audits", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const jobs = await listAuditJobs(options.pool, orgId);
    return c.json({ jobs, recommended: recommendCoverage(jobs) }, 200);
  });

  app.post("/:orgId/audits", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = CreateJobBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_audit_job", issues: parsed.error.issues }, 400);
    const job = await createAuditJob(options.pool, { orgId, ...parsed.data });
    return c.json({ job }, 201);
  });

  registerToggle(app, options.pool, "enable", true);
  registerToggle(app, options.pool, "disable", false);

  app.post("/:orgId/audits/:jobId/run", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const job = await getAuditJob(options.pool, c.req.param("jobId"));
    if (job === undefined || job.orgId !== orgId) return c.json({ error: "audit_job_not_found" }, 404);
    try {
      const result = await runAuditJob(schedulerDeps, job);
      return c.json({ job: result.job, candidates: result.candidates }, 200);
    } catch (error) {
      return c.json({ error: "audit_run_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

function registerToggle(app: Hono<ActorContextEnv>, pool: pg.Pool, verb: string, enabled: boolean): void {
  app.post(`/:orgId/audits/:jobId/${verb}`, async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const job = await getAuditJob(pool, c.req.param("jobId"));
    if (job === undefined || job.orgId !== orgId) return c.json({ error: "audit_job_not_found" }, 404);
    const updated = await setAuditJobEnabled(pool, job.id, enabled);
    return c.json({ job: updated ?? job }, 200);
  });
}

function guard(c: { var: { actor?: ActorContext } }, orgId: string): boolean {
  return c.var.actor !== undefined && actorCanAccessOrg(c.var.actor, orgId);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
