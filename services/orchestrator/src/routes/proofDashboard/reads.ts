// rv-23 — the runtime-verification DASHBOARD HTTP read surface. Org-scoped,
// read-only (GET only — no mutate endpoint), versioned under `/v1`. Every read
// runs through runWithOrgScope inside the store, so RLS confines it to the
// caller's org (a cross-org request sees ZERO rows → an empty surface).
// Authorization mirrors the rv-22 read surface: actorCanAccessOrg on the path
// org, then assertProjectAccess binds the project to that org.
//
// Mounted at "/v1/orgs" alongside rv-22 (createVerificationReadRoutes) and rv-24
// (createProofBundleRoutes):
//   GET /v1/orgs/:orgId/projects/:projectId/behavior-proof-matrix
//   GET /v1/orgs/:orgId/projects/:projectId/effect-causality
//   GET /v1/orgs/:orgId/projects/:projectId/design-render-verdicts
//   GET /v1/orgs/:orgId/projects/:projectId/regression-bisections
//   GET /v1/orgs/:orgId/projects/:projectId/flake-quarantines

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { ProofDashboardReadStore } from "../../engine/verification/acceptance/proofDashboardReadStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { RV_DASHBOARD_SURFACE_VERSION } from "./contract.js";

export interface ProofDashboardReadRoutesOptions {
  readonly pool: pg.Pool;
  readonly store?: Pick<
    ProofDashboardReadStore,
    | "readMatrix"
    | "readEffectCausality"
    | "readDesignRenderVerdicts"
    | "readRegressionBisections"
    | "readFlakeQuarantines"
  >;
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

export function createProofDashboardReadRoutes(options: ProofDashboardReadRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const store = options.store ?? new ProofDashboardReadStore(options.pool);

  app.get("/:orgId/projects/:projectId/behavior-proof-matrix", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const rows = await store.readMatrix(scope);
    return c.json({ version: RV_DASHBOARD_SURFACE_VERSION, orgId: scope.orgId, projectId: scope.projectId, rows });
  });

  app.get("/:orgId/projects/:projectId/effect-causality", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const summary = await store.readEffectCausality(scope);
    return c.json({
      version: RV_DASHBOARD_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      okCount: summary.okCount,
      missingCount: summary.missingCount,
      duplicateCount: summary.duplicateCount,
      observations: summary.observations,
    });
  });

  app.get("/:orgId/projects/:projectId/design-render-verdicts", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const verdicts = await store.readDesignRenderVerdicts(scope);
    return c.json({ version: RV_DASHBOARD_SURFACE_VERSION, orgId: scope.orgId, projectId: scope.projectId, verdicts });
  });

  app.get("/:orgId/projects/:projectId/regression-bisections", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const bisections = await store.readRegressionBisections(scope);
    return c.json({
      version: RV_DASHBOARD_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      bisections,
    });
  });

  app.get("/:orgId/projects/:projectId/flake-quarantines", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const quarantines = await store.readFlakeQuarantines(scope);
    return c.json({
      version: RV_DASHBOARD_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      quarantines,
    });
  });

  return app;
}
