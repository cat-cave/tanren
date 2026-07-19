// gv-14 — PostgreSQL proof for the governance import facade: a valid bundle
// commits atomically (tiers + revisions + active binding, with the composed
// per-op events), the admin read surface (list revisions / bindings / export)
// reflects it, and a bundle that fails MID-COMMIT (an activate-tier reference
// that resolves to no tier) rolls the ENTIRE import back — no tier, revision or
// binding is left behind. Every governed query runs as the restricted
// tanren_app role.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import { GOVERNANCE_IMPORT_API_VERSION } from "../src/engine/governance/governanceImport.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createGovernanceRoutes } from "../src/routes/governance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_governance_import_a";
const PROJECT_COMMIT = "project_governance_import_commit";
const PROJECT_ROLLBACK = "project_governance_import_rollback";
const ADMIN_ACTOR: ActorContext = {
  userId: "user_governance_import_admin",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function databaseName(): string {
  return `tanren_governance_import_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, appRole = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_ROLE;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

async function seedProject(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
    [projectId, orgId],
  );
}

function governanceApp(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ADMIN_ACTOR);
    await next();
  });
  app.route("/orgs", createGovernanceRoutes({ pool }));
  return app;
}

function requirePool(pool: Pool | undefined): Pool {
  if (pool === undefined) throw new Error("TANREN_RLS_DB_TEST did not provision the application pool");
  return pool;
}

const HUMAN_POLICY = {
  apiVersion: "tanren.dev/governance/v2",
  schemaVersion: 1,
  core: {
    rules: [
      { key: "review.mode", value: "human" },
      { key: "review.minimum_approvals", value: 2 },
    ],
  },
  org: { rules: [] },
  tier: { rules: [] },
  binding: { rules: [] },
};

describeDb("gv-14 governance import facade — atomic commit + rollback (RLS)", () => {
  const database = databaseName();
  let ownerPool: Pool | undefined;
  let appPool: Pool | undefined;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database, true) });
    await seedProject(ownerPool, ORG_A, PROJECT_COMMIT);
    await seedProject(ownerPool, ORG_A, PROJECT_ROLLBACK);
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("commits a whole bundle atomically and the admin read surface reflects it", async () => {
    const pool = requirePool(appPool);
    const app = governanceApp(pool);
    const res = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_COMMIT}/governance/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: GOVERNANCE_IMPORT_API_VERSION,
        tiers: [
          { tierName: "standard", preset: "standard" },
          { tierName: "regulated", preset: "regulated" },
        ],
        policies: [{ sourceDocument: HUMAN_POLICY }],
        activateTierName: "regulated",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      receipt: {
        tiers: { tierName: string }[];
        revisions: { id: string }[];
        activation: { tier: { tierName: string }; binding: { isActive: boolean } };
      };
    };
    expect(body.receipt.tiers.map((t) => t.tierName).sort()).toEqual(["regulated", "standard"]);
    // Two authored tiers each mint a bound revision (via findOrCreate on bind is
    // the regulated one) plus the one explicit policy => at least the explicit one.
    expect(body.receipt.revisions.length).toBeGreaterThanOrEqual(1);
    expect(body.receipt.activation.tier.tierName).toBe("regulated");
    expect(body.receipt.activation.binding.isActive).toBe(true);

    const bindingsRes = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_COMMIT}/governance/bindings`);
    expect(bindingsRes.status).toBe(200);
    const bindings = (await bindingsRes.json()) as { bindings: { isActive: boolean }[] };
    expect(bindings.bindings.filter((b) => b.isActive)).toHaveLength(1);

    const exportRes = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_COMMIT}/governance/export`);
    expect(exportRes.status).toBe(200);
    const exported = (await exportRes.json()) as {
      export: { tiers: unknown[]; revisions: unknown[]; bindings: unknown[] };
    };
    expect(exported.export.tiers).toHaveLength(2);
    expect(exported.export.revisions.length).toBeGreaterThanOrEqual(1);
    expect(exported.export.bindings.length).toBeGreaterThanOrEqual(1);

    const events = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query<{ event_type: string }>(`SELECT event_type FROM events WHERE org_id = $1 AND project_id = $2`, [
        ORG_A,
        PROJECT_COMMIT,
      ]),
    );
    const types = new Set(events.rows.map((r) => r.event_type));
    expect(types.has("governance.tier.created")).toBe(true);
    expect(types.has("governance.policy.created")).toBe(true);
    expect(types.has("governance.binding.activated")).toBe(true);
  });

  it("rolls the ENTIRE import back when the activate-tier reference resolves to nothing", async () => {
    const pool = requirePool(appPool);
    const app = governanceApp(pool);
    const res = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_ROLLBACK}/governance/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: GOVERNANCE_IMPORT_API_VERSION,
        // These tiers + policy WOULD persist on commit, but the unknown
        // activate-tier reference throws mid-transaction, rolling them back.
        tiers: [{ tierName: "standard", preset: "standard" }],
        policies: [{ sourceDocument: HUMAN_POLICY }],
        activateTierName: "does_not_exist",
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("governance_import_tier_not_found");

    // No partial state: the earlier tier + revision inserts were rolled back.
    const tiers = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query(`SELECT id FROM governance_tiers WHERE org_id = $1 AND project_id = $2`, [ORG_A, PROJECT_ROLLBACK]),
    );
    expect(tiers.rows).toEqual([]);
    const revisions = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query(`SELECT id FROM governance_policy_revisions WHERE org_id = $1 AND project_id = $2`, [
        ORG_A,
        PROJECT_ROLLBACK,
      ]),
    );
    expect(revisions.rows).toEqual([]);
    const bindings = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query(`SELECT id FROM policy_bindings WHERE org_id = $1 AND project_id = $2`, [ORG_A, PROJECT_ROLLBACK]),
    );
    expect(bindings.rows).toEqual([]);
    const events = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query(`SELECT id FROM events WHERE org_id = $1 AND project_id = $2`, [ORG_A, PROJECT_ROLLBACK]),
    );
    expect(events.rows).toEqual([]);
  });
});
