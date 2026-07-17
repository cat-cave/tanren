import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  bindGovernanceTier,
  createGovernanceTier,
  GovernanceTierIntegrityError,
  GovernanceTierNotFoundError,
  listGovernanceTiers,
} from "../../engine/governance/governanceTierStore.js";
import { GovernanceTierPresetSchema } from "../../engine/governance/tierPresets.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

const CreateTierBodySchema = z
  .object({
    tierName: z.string().min(1).max(256),
    preset: GovernanceTierPresetSchema,
  })
  .strict();

export interface GovernanceTierRoutesOptions {
  readonly pool: pg.Pool;
}

interface AuthorizedProject {
  readonly actor: ActorContext;
  readonly orgId: string;
  readonly projectId: string;
}

export function createGovernanceTierRoutes(options: GovernanceTierRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/governance/tiers", async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    const tiers = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
      listGovernanceTiers(client, authorized.orgId, authorized.projectId),
    );
    return c.json({ tiers });
  });

  app.post("/:orgId/projects/:projectId/governance/tiers", async (c) => {
    const authorized = await authorizeProject(c, options.pool, true);
    if (isResponse(authorized)) return authorized;
    const parsed = CreateTierBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c, parsed.error);
    try {
      const tier = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
        createGovernanceTier(client, { orgId: authorized.orgId, projectId: authorized.projectId, ...parsed.data }),
      );
      return c.json({ tier }, 201);
    } catch (error) {
      return handleTierError(c, error, "governance_tier_create_failed");
    }
  });

  app.post("/:orgId/projects/:projectId/governance/tiers/:tierId/activate", async (c) => activateTier(c, options.pool));
  app.post("/:orgId/projects/:projectId/governance/tiers/:tierId/bind", async (c) => activateTier(c, options.pool));

  return app;
}

async function activateTier(c: Context<ActorContextEnv>, pool: pg.Pool): Promise<Response> {
  const authorized = await authorizeProject(c, pool, true);
  if (isResponse(authorized)) return authorized;
  const tierId = c.req.param("tierId");
  if (tierId === undefined) return c.json({ error: "tier_scope_missing" }, 500);
  try {
    const activated = await runWithOrgScope(pool, authorized.orgId, (client) =>
      bindGovernanceTier(client, {
        orgId: authorized.orgId,
        projectId: authorized.projectId,
        tierId,
      }),
    );
    return c.json(activated, 201);
  } catch (error) {
    return handleTierError(c, error, "governance_tier_activate_failed");
  }
}

async function authorizeProject(
  c: Context<ActorContextEnv>,
  pool: pg.Pool,
  write: boolean,
): Promise<AuthorizedProject | Response> {
  const actor = c.var.actor;
  const orgId = c.req.param("orgId");
  const projectId = c.req.param("projectId");
  if (actor === undefined || orgId === undefined || projectId === undefined) {
    return c.json({ error: "actor_or_scope_missing" }, 500);
  }
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  if (write && !actorIsOrgAdmin(actor, orgId)) return c.json({ error: "governance_admin_required" }, 403);
  try {
    const access = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (access.orgId !== orgId) return c.json({ error: "org_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { actor, orgId, projectId };
}

function isResponse(value: AuthorizedProject | Response): value is Response {
  return value instanceof Response;
}

function invalidBody(c: Context<ActorContextEnv>, error: z.ZodError): Response {
  return c.json({ error: "invalid_governance_tier", issues: error.issues }, 400);
}

function handleTierError(c: Context<ActorContextEnv>, error: unknown, fallback: string): Response {
  if (error instanceof GovernanceTierNotFoundError) return c.json({ error: "governance_tier_not_found" }, 404);
  if (error instanceof GovernanceTierIntegrityError) return c.json({ error: "governance_tier_integrity_failed" }, 409);
  return c.json({ error: fallback, message: error instanceof Error ? error.message : String(error) }, 500);
}
