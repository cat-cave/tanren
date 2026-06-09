// scheduled-audits HTTP routes.
//
//   GET  /:orgId/audits                      → { jobs, recommended }
//   POST /:orgId/audits                       create an audit job (the composer)
//   POST /:orgId/audits/:jobId/enable         enable the job
//   POST /:orgId/audits/:jobId/disable        pause the job
//   POST /:orgId/audits/:jobId/run            run the read-only pass now →
//                                             findings auto-route into the DAG
//
// The pass runner is REQUIRED (the production default is the real Answerer-backed
// pass over the project's repo; tests inject a fake). Mounted on the shared
// `/orgs` base. A run executes the read-only pass; each finding is triaged and —
// when auto-routable — COMMITTED INTO THE DAG as a spec (no operator), the same
// hand-off the autonomous loop runs. This route never forks the inbox.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  AuditCadence,
  AuditKind,
  AuditsStore,
  recommendCoverage,
  runAuditJob,
  type AuditPassRunner,
  type AuditSchedulerDeps,
} from "../../engine/forge/audits/index.js";
import type { TriageAnswerer } from "../../engine/forge/inbox/index.js";
import { intakeAutoRouteDeps } from "../../engine/forge/intake/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

export interface AuditRoutesOptions {
  pool: pg.Pool;
  // The read-only pass executor — REQUIRED. Production injects the real
  // Answerer-backed runner (`createAnswererPassRunner`, which indexes the
  // project's repo READ-ONLY and has the audit answerer surface findings); tests
  // inject a fake. There is NO no-op default (§8a — a clean pass must be the
  // answerer's honest verdict, never a silent stub).
  passRunner: AuditPassRunner;
  // The triage answerer factory, called per-run with the job's org/project so an
  // emitted finding is triaged by a REAL provider answerer
  // (`buildForgeTriageAnswererFactory`); tests pass a fake. REQUIRED — there is
  // no deterministic fallback.
  answererFactory: (target: ForgeAnswererTarget) => TriageAnswerer;
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
  const passRunner = options.passRunner;

  app.get("/:orgId/audits", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const jobs = await AuditsStore.listAuditJobs(options.pool, orgId);
    return c.json({ jobs, recommended: recommendCoverage(jobs) }, 200);
  });

  app.post("/:orgId/audits", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = CreateJobBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_audit_job", issues: parsed.error.issues }, 400);
    const job = await AuditsStore.createAuditJob(options.pool, { orgId, ...parsed.data });
    return c.json({ job }, 201);
  });

  registerToggle(app, options.pool, "enable", true);
  registerToggle(app, options.pool, "disable", false);

  app.post("/:orgId/audits/:jobId/run", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const job = await AuditsStore.getAuditJob(options.pool, c.req.param("jobId"));
    if (job === undefined || job.orgId !== orgId) return c.json({ error: "audit_job_not_found" }, 404);
    const schedulerDeps: AuditSchedulerDeps = {
      pool: options.pool,
      passRunner,
      answerer: options.answererFactory({
        orgId,
        ...(job.projectId === null ? {} : { projectId: job.projectId }),
      }),
      // Auto-route an auto-routable finding's spec into the DAG (no operator) —
      // the SAME hand-off the autonomous loop runs. A finding→spec is the
      // autonomous intake path (not the operator's personal write), so it commits
      // under the SAME org-scoped system actor the loop/poller use
      // (`intakeAutoRouteDeps`), RLS-scoped to the request's org. The route's
      // org-scoped pool enforces RLS; no separate control-plane writer is needed
      // (that split lives in the worker).
      autoRoute: intakeAutoRouteDeps(),
    };
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
    const job = await AuditsStore.getAuditJob(pool, c.req.param("jobId"));
    if (job === undefined || job.orgId !== orgId) return c.json({ error: "audit_job_not_found" }, 404);
    const updated = await AuditsStore.setAuditJobEnabled(pool, job.id, enabled);
    return c.json({ job: updated ?? job }, 200);
  });
}

function guard(c: { var: { actor?: ActorContext } }, orgId: string): boolean {
  return c.var.actor !== undefined && actorCanAccessOrg(c.var.actor, orgId);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-export the sibling template-REGISTRY route factory through this module so
// mountFeatureRoutes spreads both org-scoped library surfaces in from ONE import
// (keeping mountFeatureRoutes under its max-dependencies cap), the same grouping
// pattern forge/mount.js uses. Source of truth is routes/templates/index.ts.
export { createTemplateRoutes } from "../templates/index.js";
// Wave-4 templating: the LIVE creation-flow assembly + the selection no-match →
// creation seam builder, re-exported through this barrel for the SAME reason —
// mountFeatureRoutes spreads them in without a new top-level import (the
// max-dependencies cap). Source of truth is routes/templates/createFlow.ts.
export { buildCreateForNoMatch, buildCreateTemplateFlow } from "../templates/createFlow.js";
