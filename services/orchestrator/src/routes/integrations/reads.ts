// in-20 — the integration HTTP READ surface. Org+project-scoped, GET-only
// (no mutate endpoint), versioned under `/v1`. Every read runs through
// `runWithOrgScope` inside an `assertProjectAccess` gate, so RLS confines each
// query to the caller's org (a cross-org request sees ZERO rows → empty list)
// and project membership denies a non-member with 403/404.
//
// Mirrors `routes/runtimeVerification/reads.ts` (rv-22) shape-for-shape:
// authorization runs `actorCanAccessOrg` on the path org, then
// `assertProjectAccess` binds the project to that org inside `runWithOrgScope`.
// Each handler reads through the store modules under `routes/integrations/` and
// surfaces the versioned response; an unexpected row shape throws → 500, never
// a partial or laundered body.
//
// Mounted at "/v1/orgs" (one `app.route` line in `mountFeatureRoutes.ts`):
//   GET /v1/orgs/:orgId/projects/:projectId/integrations/lifecycle
//   GET /v1/orgs/:orgId/projects/:projectId/integration-requirements
//   GET /v1/orgs/:orgId/projects/:projectId/capability-nodes
//   GET /v1/orgs/:orgId/projects/:projectId/integration-bindings
//   GET /v1/orgs/:orgId/projects/:projectId/delivery

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { INTEGRATION_READ_SURFACE_VERSION } from "./contract.js";
import {
  listIntegrationBindings,
  listCapabilityNodes,
  listIntegrationRequirements,
  readDeliveryDagStatus,
  readLifecycleInventory,
} from "./integrationReadStore.js";

export interface IntegrationReadRoutesOptions {
  readonly pool: pg.Pool;
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

function scopeOf(scope: { orgId: string; projectId: string }) {
  return { orgId: scope.orgId, projectId: scope.projectId };
}

export function createIntegrationReadRoutes(options: IntegrationReadRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const pool = options.pool;

  app.get("/:orgId/projects/:projectId/integrations/lifecycle", async (c) => {
    const scope = await authorizeProject(c, pool);
    if (isResponse(scope)) return scope;
    const inventory = await runWithOrgScope(pool, scope.orgId, (client: IntegrationQueryClient) =>
      readLifecycleInventory(client, scopeOf(scope)),
    );
    if (inventory === undefined) return c.json({ error: "lifecycle_inventory_not_found" }, 404);
    return c.json(inventory);
  });

  app.get("/:orgId/projects/:projectId/integration-requirements", async (c) => {
    const scope = await authorizeProject(c, pool);
    if (isResponse(scope)) return scope;
    const response = await runWithOrgScope(pool, scope.orgId, (client: IntegrationQueryClient) =>
      listIntegrationRequirements(client, scopeOf(scope)),
    );
    return c.json(response);
  });

  app.get("/:orgId/projects/:projectId/capability-nodes", async (c) => {
    const scope = await authorizeProject(c, pool);
    if (isResponse(scope)) return scope;
    const response = await runWithOrgScope(pool, scope.orgId, (client: IntegrationQueryClient) =>
      listCapabilityNodes(client, scopeOf(scope)),
    );
    return c.json(response);
  });

  app.get("/:orgId/projects/:projectId/integration-bindings", async (c) => {
    const scope = await authorizeProject(c, pool);
    if (isResponse(scope)) return scope;
    const response = await runWithOrgScope(pool, scope.orgId, (client: IntegrationQueryClient) =>
      listIntegrationBindings(client, scopeOf(scope)),
    );
    return c.json(response);
  });

  app.get("/:orgId/projects/:projectId/delivery", async (c) => {
    const scope = await authorizeProject(c, pool);
    if (isResponse(scope)) return scope;
    const response = await runWithOrgScope(pool, scope.orgId, (client: IntegrationQueryClient) =>
      readDeliveryDagStatus(client, scopeOf(scope)),
    );
    return c.json(response);
  });

  return app;
}

// Surface the version tag at the module boundary so external code can pin
// against it without importing the contract module directly.
export { INTEGRATION_READ_SURFACE_VERSION };
