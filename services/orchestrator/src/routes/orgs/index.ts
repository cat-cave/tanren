// org-scoped CRUD routes. Org list/read/config-update.
// Authorization: every route requires the actor to be a member of the
// addressed org (or `platform:admin`). Org config uses the typed
// `OrgConfigV1` shape from.

import { runWithSystemScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { DEFAULT_BUDGET_PERIOD } from "../../engine/config/index.js";
import { migrateOrgConfig, type OrgAuditGateTarget, type OrgConfigV1 } from "../../engine/config/orgConfig.js";
import { gatedConfigWrite, type ConfigGateGitHub } from "../../engine/config/tanrenConfigGate.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "./access.js";

// Wave-2 "Connect GitHub" + onboarding-status routes live in the sibling
// `github.ts`; re-exported here so the feature-mount table imports the whole
// org-route surface from one module (keeping its dependency count in budget).
export { createGithubConnectRoutes } from "./github.js";

/**
 * resolve the injectable GitHub port the audit gate opens its PR with,
 * for a given org + target. `undefined` means "no client available" — the route
 * then refuses to apply a gated write rather than silently bypassing the gate.
 * The factory is async + per-request so the App token is freshly minted.
 */
export type ConfigGateGithubFactory = (
  orgId: string,
  target: OrgAuditGateTarget,
) => Promise<ConfigGateGitHub | undefined>;

interface OrgRoutesOptions {
  pool: pg.Pool;
  /** audit-gate GitHub port factory; omitted in pure config tests. */
  configGateGithub?: ConfigGateGithubFactory;
}

const OrgConfigPatchSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

// `ceilingUsd: null` clears the org's default budget; a number (+ optional period)
// sets it. The org-level DEFAULT every project inherits unless it sets its own.
const OrgBudgetPutSchema = z
  .object({
    ceilingUsd: z.number().nonnegative().nullable(),
    period: z.enum(["monthly", "total"]).optional(),
  })
  .strict();

export function createOrgRoutes(options: OrgRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/", async (c) => {
    const actor = requireActor(c);
    // RLS R3b: "which orgs does this user belong to" is a user-scoped tenant
    // BOOTSTRAP read that PRECEDES any org scope — it is how a user DISCOVERS
    // their orgs (the org-switcher / dashboard shell backing query), the
    // chicken-and-egg before an `app.current_org_id` can be selected. On the
    // runtime `tanren_app` role (NOBYPASSRLS) with an empty GUC, the
    // deny-by-default policies on `organizations` + `org_members`
    // (`USING ... = current_setting('app.current_org_id', true)`) return ZERO
    // rows, so the list comes back empty under enforced RLS. So — mirroring
    // `identityStore`'s already-system-scoped membership resolution — this read
    // runs on the BYPASSRLS `tanren_system` pool via `runWithSystemScope`,
    // filtered by `user_id`. The result is still correctly scoped (the user's
    // OWN memberships), just not subject to the org-GUC RLS filter that cannot
    // apply pre-scope. IN-ORG reads (the `/:orgId` routes below) stay under RLS.
    const rows = await runWithSystemScope(options.pool, (client) =>
      client.query<OrgListRow>(
        `SELECT o.id, o.kind, o.login, o.display_name, m.role
           FROM organizations o
           INNER JOIN org_members m ON m.org_id = o.id
          WHERE m.user_id = $1
          ORDER BY o.login`,
        [actor.userId],
      ),
    );
    return c.json({
      orgs: rows.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        login: row.login,
        displayName: row.display_name,
        role: row.role,
      })),
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
      [orgId],
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
      config: migrateOrgConfig(row.config),
    });
  });

  app.patch("/:orgId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = OrgConfigPatchSchema.safeParse(await c.req.json().catch(() => {}));
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
    const current = await options.pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [
      orgId,
    ]);
    if (current.rows[0] === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const prevConfig = migrateOrgConfig(current.rows[0].config);

    // when the gate is ON and this is a Bucket-B write, do NOT apply —
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
            : undefined,
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
      [JSON.stringify(gated.config), orgId],
    );
    if (updated.rowCount === 0) {
      return c.json({ error: "org_not_found" }, 404);
    }
    return c.json({ id: orgId, config: gated.config });
  });

  // The org-level DEFAULT dollar budget (autonomy-engine.md §3 proof 6): the
  // ceiling every project inherits unless it sets its own. A dedicated, discoverable
  // read + update over `organizations.config.defaultBudget` — `defaultBudget` is NOT
  // a Bucket-B (routing/limits) field, so it is never audit-gated; the write applies
  // directly. No per-project spend is summed here (spend is per-project).
  app.get("/:orgId/budget", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const result = await options.pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [
      orgId,
    ]);
    if (result.rows[0] === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const budget = migrateOrgConfig(result.rows[0].config).defaultBudget;
    return c.json({
      ceilingUsd: budget?.ceilingUsd ?? null,
      period: budget?.period ?? DEFAULT_BUDGET_PERIOD,
    });
  });

  app.put("/:orgId/budget", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = OrgBudgetPutSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_budget", issues: parsed.error.issues }, 400);
    }
    const current = await options.pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [
      orgId,
    ]);
    if (current.rows[0] === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const prev = migrateOrgConfig(current.rows[0].config);
    const nextConfig = migrateOrgConfig({
      ...prev,
      defaultBudget:
        parsed.data.ceilingUsd === null
          ? undefined
          : { ceilingUsd: parsed.data.ceilingUsd, period: parsed.data.period ?? DEFAULT_BUDGET_PERIOD },
    });
    await options.pool.query("UPDATE organizations SET config = $1::jsonb, updated_at = now() WHERE id = $2", [
      JSON.stringify(nextConfig),
      orgId,
    ]);
    return c.json({
      ceilingUsd: nextConfig.defaultBudget?.ceilingUsd ?? null,
      period: nextConfig.defaultBudget?.period ?? DEFAULT_BUDGET_PERIOD,
    });
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Wave-2 operator API: the "Connect AI provider" + billing-mode settings live in
// a sibling module but are re-exported HERE so the feature-route mount table
// imports both org-settings factories from one place (keeping its dependency
// count within the architecture cap). The route is org-scoped + actor-authorized
// exactly like the org routes above; see routes/aiProvider/index.ts.
export { createAiProviderRoutes } from "../aiProvider/index.js";
// Codex H3 #21: the operator-facing manual_external deploy CONFIRMATION route
// (POST /orgs/:orgId/projects/:projectId/deploys/:deploymentId/confirm) also
// mounts on `/orgs`, so it re-exports through this barrel to keep the feature-
// mount table's dependency count within the architecture cap.
export { createDeployRoutes } from "../deploys/index.js";

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
