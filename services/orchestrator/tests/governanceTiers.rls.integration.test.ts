// PostgreSQL proof for gv-8's immutable governance tiers. Run only with a
// disposable database owner URL; every governed assertion uses tanren_app.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  createGovernanceTier,
  listGovernanceTiers,
  type GovernanceTier,
} from "../src/engine/governance/governanceTierStore.js";
import {
  GOVERNANCE_TIER_PRESET_NAMES,
  governanceTierPreset,
  type GovernanceTierPreset,
} from "../src/engine/governance/tierPresets.js";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createGovernanceRoutes } from "../src/routes/governance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_governance_tiers_a";
const ORG_B = "org_governance_tiers_b";
const PROJECT_A = "project_governance_tiers_a";
const PROJECT_B = "project_governance_tiers_b";
const ADMIN_ACTOR: ActorContext = {
  userId: "user_governance_tiers_admin",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function databaseName(): string {
  return `tanren_governance_tiers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
    [projectId, orgId],
  );
}

function compiledPreset(preset: GovernanceTierPreset) {
  const compiled = compilePolicy(governanceTierPreset(preset).sourceDocument);
  if (compiled.status !== "compiled") throw new Error(`preset ${preset} must compile`);
  return compiled;
}

function ruleValue(tier: GovernanceTier, key: string): unknown {
  return compiledPreset(tier.preset).ast.rules.find((rule) => rule.key === key)?.value;
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

describeDb("governance tiers — deterministic, append-only, and org-scoped", () => {
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
    await seedProject(ownerPool, ORG_A, PROJECT_A);
    await seedProject(ownerPool, ORG_B, PROJECT_B);
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

  it("compiles every preset deterministically, preserves tiers, binds private visibility, and emits the frozen events", async () => {
    const pool = requirePool(appPool);
    const tiers = new Map<GovernanceTierPreset, GovernanceTier>();
    for (const preset of GOVERNANCE_TIER_PRESET_NAMES) {
      const first = compiledPreset(preset);
      const second = compiledPreset(preset);
      expect(second.ast).toEqual(first.ast);
      expect(second.policyHash).toBe(first.policyHash);

      const tier = await runWithOrgScope(pool, ORG_A, (client) =>
        createGovernanceTier(client, {
          orgId: ORG_A,
          projectId: PROJECT_A,
          tierName: `tier-${preset}`,
          preset,
        }),
      );
      expect(tier.canonicalHash).toBe(first.policyHash);
      const persisted = compilePolicy(tier.tierJson);
      expect(persisted.status).toBe("compiled");
      if (persisted.status !== "compiled") throw new Error("persisted tier must compile");
      expect(persisted.policyHash).toBe(tier.canonicalHash);
      tiers.set(preset, tier);
    }

    expect(await runWithOrgScope(pool, ORG_A, (client) => listGovernanceTiers(client, ORG_A, PROJECT_A))).toHaveLength(
      4,
    );
    expect(await runWithOrgScope(pool, ORG_B, (client) => listGovernanceTiers(client, ORG_B, PROJECT_B))).toEqual([]);

    const privateTier = requireTier(tiers.get("private"));
    const regulatedTier = requireTier(tiers.get("regulated"));
    expect(ruleValue(privateTier, "repository.visibility")).toBe("private");
    expect(ruleValue(regulatedTier, "repository.visibility")).toBe("private");
    expect(ruleValue(privateTier, "review.minimum_approvals")).toBe(1);
    expect(ruleValue(regulatedTier, "review.minimum_approvals")).toBe(2);

    const app = governanceApp(pool);
    const createdByRoute = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_A}/governance/tiers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tierName: "tier-route", preset: "standard" }),
    });
    expect(createdByRoute.status).toBe(201);

    const listedByRoute = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_A}/governance/tiers`);
    expect(listedByRoute.status).toBe(200);
    expect(((await listedByRoute.json()) as { tiers: unknown[] }).tiers).toHaveLength(5);

    const activatedByRoute = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_A}/governance/tiers/${privateTier.id}/activate`,
      { method: "POST" },
    );
    expect(activatedByRoute.status).toBe(201);
    const activated = (await activatedByRoute.json()) as { binding: { id: string; effectivePolicyHash: string } };
    expect(activated.binding.effectivePolicyHash).toBe(privateTier.canonicalHash);

    const visibility = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query<{ repo_visibility: string | null }>(
        "SELECT repo_visibility FROM projects WHERE org_id = $1 AND project_id = $2",
        [ORG_A, PROJECT_A],
      ),
    );
    expect(visibility.rows[0]?.repo_visibility).toBe("private");

    await expect(
      runWithOrgScope(pool, ORG_A, (client) =>
        client.query("UPDATE governance_tiers SET state = 'tampered' WHERE org_id = $1 AND id = $2", [
          ORG_A,
          privateTier.id,
        ]),
      ),
    ).rejects.toThrow(/append-only/u);

    const crossOrg = await runWithOrgScope(pool, ORG_B, (client) =>
      client.query("SELECT id FROM governance_tiers WHERE id = $1", [privateTier.id]),
    );
    expect(crossOrg.rows).toHaveLength(0);

    const events = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query<{ event_type: string; binding_id: string | null }>(
        `SELECT event_type, payload->>'policyBindingId' AS binding_id
           FROM events
          WHERE org_id = $1 AND project_id = $2
            AND payload->>'tierId' = $3
          ORDER BY id`,
        [ORG_A, PROJECT_A, privateTier.id],
      ),
    );
    expect(events.rows).toEqual([
      { event_type: "governance.tier.created", binding_id: null },
      { event_type: "governance.tier.activated", binding_id: activated.binding.id },
    ]);
  });
});

function requirePool(pool: Pool | undefined): Pool {
  if (pool === undefined) throw new Error("TANREN_RLS_DB_TEST did not provision the application pool");
  return pool;
}

function requireTier(tier: GovernanceTier | undefined): GovernanceTier {
  if (tier === undefined) throw new Error("expected governance tier to be created");
  return tier;
}
