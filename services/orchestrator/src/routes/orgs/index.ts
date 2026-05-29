// P2A-0013: org-scoped CRUD routes. Org list/read/config-update.
// Authorization: every route requires the actor to be a member of the
// addressed org (or `platform:admin`). Org config uses the typed
// `OrgConfigV1` shape from P2A-0006.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateOrgConfig, type OrgAuditGateTarget, type OrgConfigV1 } from "../../engine/config/orgConfig.js";
import { gatedConfigWrite, type ConfigGateGitHub } from "../../engine/config/tanrenConfigGate.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

/**
 * P3-0017: resolve the injectable GitHub port the audit gate opens its PR with,
 * for a given org + target. `undefined` means "no client available" — the route
 * then refuses to apply a gated write rather than silently bypassing the gate.
 * The factory is async + per-request so the App token is freshly minted.
 */
export type ConfigGateGithubFactory = (
  orgId: string,
  target: OrgAuditGateTarget
) => Promise<ConfigGateGitHub | undefined>;

interface OrgRoutesOptions {
  pool: pg.Pool;
  /** P3-0017 audit-gate GitHub port factory; omitted in pure config tests. */
  configGateGithub?: ConfigGateGithubFactory;
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
    let nextConfig: OrgConfigV1;
    try {
      nextConfig = migrateOrgConfig(parsed.data.config);
    } catch (error) {
      return c.json({ error: "invalid_org_config", message: messageOf(error) }, 400);
    }

    // Load the current config so the audit gate can detect a Bucket-B change.
    const current = await options.pool.query<{ config: unknown }>(
      "SELECT config FROM organizations WHERE id = $1",
      [orgId]
    );
    if (current.rows[0] === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const prevConfig = migrateOrgConfig(current.rows[0].config);

    // P3-0017: when the gate is ON and this is a Bucket-B write, do NOT apply —
    // open a PR in the tanren-config repo and report the gated outcome instead.
    let gated: Awaited<ReturnType<typeof gatedConfigWrite>>;
    try {
      gated = await gatedConfigWrite({
        prev: prevConfig,
        next: nextConfig,
        target: nextConfig.auditGate,
        github:
          nextConfig.auditGate !== undefined && options.configGateGithub !== undefined
            ? await options.configGateGithub(orgId, nextConfig.auditGate)
            : undefined
      });
    } catch (error) {
      return c.json({ error: "audit_gate_failed", message: messageOf(error) }, 502);
    }

    if (gated.kind === "gated") {
      // The DB stays the source of truth; the write applies on PR merge.
      return c.json({ id: orgId, gated: true, pr: gated.pr, diff: gated.diff }, 202);
    }

    const updated = await options.pool.query<{ id: string }>(
      "UPDATE organizations SET config = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING id",
      [JSON.stringify(gated.config), orgId]
    );
    if (updated.rowCount === 0) {
      return c.json({ error: "org_not_found" }, 404);
    }
    return c.json({ id: orgId, config: gated.config });
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
