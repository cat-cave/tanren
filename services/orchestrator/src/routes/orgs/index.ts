// P2A-0013: org-scoped CRUD routes. Org list/read/config-update.
// Authorization: every route requires the actor to be a member of the
// addressed org (or `platform:admin`). Org config uses the typed
// `OrgConfigV1` shape from P2A-0006.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateOrgConfig } from "../../engine/config/orgConfig.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

interface OrgRoutesOptions {
  pool: pg.Pool;
}

const OrgConfigPatchSchema = z.object({
  config: z.record(z.string(), z.unknown())
});

export function createOrgRoutes(options: OrgRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/", async (c) => {
    const actor = requireActor(c);
    const rows = await options.pool.query<OrgListRow>(
      `SELECT o.id, o.kind, o.login, o.display_name, m.role
         FROM organizations o
         INNER JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.login`,
      [actor.userId]
    );
    return c.json({
      orgs: rows.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        login: row.login,
        displayName: row.display_name,
        role: row.role
      }))
    });
  });

  app.get("/:orgId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const result = await options.pool.query<OrgConfigRow>(
      "SELECT id, kind, login, display_name, config FROM organizations WHERE id = $1",
      [orgId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    return c.json({
      id: row.id,
      kind: row.kind,
      login: row.login,
      displayName: row.display_name,
      config: migrateOrgConfig(row.config)
    });
  });

  app.patch("/:orgId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = OrgConfigPatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_org_config", issues: parsed.error.issues }, 400);
    }
    let nextConfig;
    try {
      nextConfig = migrateOrgConfig(parsed.data.config);
    } catch (error) {
      return c.json({ error: "invalid_org_config", message: messageOf(error) }, 400);
    }
    const updated = await options.pool.query<{ id: string }>(
      "UPDATE organizations SET config = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING id",
      [JSON.stringify(nextConfig), orgId]
    );
    if (updated.rowCount === 0) {
      return c.json({ error: "org_not_found" }, 404);
    }
    return c.json({ id: orgId, config: nextConfig });
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

export function actorCanAccessOrg(actor: ActorContext, orgId: string): boolean {
  if (actor.scopes.includes("platform:admin")) return true;
  if (actor.orgId !== orgId) return false;
  return actor.scopes.includes("org:member") || actor.scopes.includes("org:admin");
}

export function actorIsOrgAdmin(actor: ActorContext, orgId: string): boolean {
  if (actor.scopes.includes("platform:admin")) return true;
  if (actor.orgId !== orgId) return false;
  return actor.scopes.includes("org:admin");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface OrgListRow {
  id: string;
  kind: string;
  login: string;
  display_name: string;
  role: string;
}

interface OrgConfigRow {
  id: string;
  kind: string;
  login: string;
  display_name: string;
  config: unknown;
}
