// rv-22 — the runtime-verification HTTP READ surface. Org-scoped, read-only
// (GET only — no mutate endpoint), versioned under `/v1`. Every read runs through
// runWithOrgScope inside the store, so RLS confines it to the caller's org (a
// cross-org request sees ZERO rows → 404). Authorization mirrors the behavior-
// coverage surface: actorCanAccessOrg on the path org, then assertProjectAccess
// binds the project to that org.
//
// This CONSOLIDATES with rv-24's proof-bundle route (mounted on the same
// `/v1/orgs` sub-mount): the run-detail response links to that per-run bundle via
// `proofBundleHref` rather than re-implementing bundle assembly.
//
// Mounted at "/v1/orgs":
//   GET /v1/orgs/:orgId/projects/:projectId/verification-runs
//   GET /v1/orgs/:orgId/projects/:projectId/verification-runs/:runId
//   GET /v1/orgs/:orgId/projects/:projectId/behaviors/:behaviorRevisionId/verdicts

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { VerificationReadStore } from "../../engine/verification/acceptance/verificationReadStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { RV_READ_SURFACE_VERSION } from "./contract.js";

export interface VerificationReadRoutesOptions {
  readonly pool: pg.Pool;
  readonly store?: Pick<VerificationReadStore, "listRuns" | "readRunDetail" | "readBehaviorHistory">;
}

type RouteContext = Context<ActorContextEnv>;

function requireActor(c: RouteContext): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`route parameter ${name} missing`);
  return value;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function authorizeProject(
  c: RouteContext,
  pool: pg.Pool,
): Promise<{ orgId: string; projectId: string } | Response> {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  const projectId = requireParam(c, "projectId");
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  try {
    const project = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (project.orgId !== orgId) return c.json({ error: "project_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { orgId, projectId };
}

export function createVerificationReadRoutes(options: VerificationReadRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const store = options.store ?? new VerificationReadStore(options.pool);

  app.get("/:orgId/projects/:projectId/verification-runs", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const runs = await store.listRuns(scope);
    return c.json({ version: RV_READ_SURFACE_VERSION, orgId: scope.orgId, projectId: scope.projectId, runs });
  });

  app.get("/:orgId/projects/:projectId/verification-runs/:runId", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const runId = requireParam(c, "runId");
    const detail = await store.readRunDetail(scope, runId);
    if (detail === undefined) return c.json({ error: "verification_run_not_found" }, 404);
    return c.json({
      version: RV_READ_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      run: detail.run,
      environment: detail.environment,
      verdicts: detail.verdicts,
      proofBundleHref: `/v1/orgs/${scope.orgId}/projects/${scope.projectId}/verification-runs/${runId}/proof-bundle`,
    });
  });

  app.get("/:orgId/projects/:projectId/behaviors/:behaviorRevisionId/verdicts", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const behaviorRevisionId = requireParam(c, "behaviorRevisionId");
    const history = await store.readBehaviorHistory(scope, behaviorRevisionId);
    return c.json({
      version: RV_READ_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      behaviorRevisionId,
      latestOutcome: history.latestOutcome,
      verdicts: history.verdicts,
    });
  });

  return app;
}
