// PostgreSQL proof for gv-9's immutable policy bindings and effective-policy receipts.
// Every governed query uses the restricted tanren_app role; the owner only provisions
// the disposable database and its two tenant roots.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  bindGovernanceTier,
  createGovernanceTier,
  type GovernanceTier,
} from "../src/engine/governance/governanceTierStore.js";
import {
  getEffectivePolicySnapshot,
  recordEffectivePolicySnapshot,
} from "../src/engine/governance/effectivePolicySnapshotStore.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createGovernanceRoutes } from "../src/routes/governance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_governance_bindings_a";
const ORG_B = "org_governance_bindings_b";
const PROJECT_A = "project_governance_bindings_a";
const PROJECT_B = "project_governance_bindings_b";
const ADMIN_ACTOR: ActorContext = {
  userId: "user_governance_bindings_admin",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function databaseName(): string {
  return `tanren_governance_bindings_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function requireTier(tier: GovernanceTier | undefined): GovernanceTier {
  if (tier === undefined) throw new Error("expected governance tier to be created");
  return tier;
}

describeDb("governance bindings and effective-policy receipts — RLS and append-only", () => {
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

  it("activates and supersedes bindings, records immutable receipts, and isolates tenants", async () => {
    const pool = requirePool(appPool);
    const standardTier = await runWithOrgScope(pool, ORG_A, (client) =>
      createGovernanceTier(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        tierName: "standard",
        preset: "standard",
      }),
    );
    const privateTier = await runWithOrgScope(pool, ORG_A, (client) =>
      createGovernanceTier(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        tierName: "private",
        preset: "private",
      }),
    );
    const app = governanceApp(pool);

    const firstActivation = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_A}/governance/tiers/${standardTier.id}/bind`,
      { method: "POST" },
    );
    expect(firstActivation.status).toBe(201);
    const firstBody = (await firstActivation.json()) as {
      binding: { id: string };
      policyRevisionId: string;
    };
    expect(firstBody.binding.id).toMatch(/^policy_binding_/u);
    expect(firstBody.policyRevisionId).toMatch(/^policy_revision_/u);

    const secondActivation = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_A}/governance/tiers/${privateTier.id}/bind`,
      { method: "POST" },
    );
    expect(secondActivation.status).toBe(201);
    const secondBody = (await secondActivation.json()) as { binding: { id: string } };
    expect(secondBody.binding.id).not.toBe(firstBody.binding.id);

    const runReceipt = await runWithOrgScope(pool, ORG_A, (client) =>
      recordEffectivePolicySnapshot(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        subjectKind: "run",
        subjectId: "run_governance_receipt_a",
        createdBy: ADMIN_ACTOR.userId,
      }),
    );
    const repeatReceipt = await runWithOrgScope(pool, ORG_A, (client) =>
      recordEffectivePolicySnapshot(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        subjectKind: "run",
        subjectId: "run_governance_receipt_a",
        createdBy: ADMIN_ACTOR.userId,
      }),
    );
    expect(repeatReceipt.id).not.toBe(runReceipt.id);
    expect(repeatReceipt.effectivePolicyHash).toBe(runReceipt.effectivePolicyHash);
    expect(repeatReceipt.inputsDigest).toBe(runReceipt.inputsDigest);
    expect(repeatReceipt.compiledBody).toEqual(runReceipt.compiledBody);

    await expect(
      runWithOrgScope(pool, ORG_A, (client) =>
        client.query("UPDATE effective_policy_snapshots SET subject_id = $3 WHERE org_id = $1 AND id = $2", [
          ORG_A,
          runReceipt.id,
          "tampered",
        ]),
      ),
    ).rejects.toThrow(/append-only/u);

    const readReceipt = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_A}/governance/effective/run/run_governance_receipt_a`,
    );
    expect(readReceipt.status).toBe(200);
    const readBody = (await readReceipt.json()) as { snapshot: { id: string; effectivePolicyHash: string } };
    expect(readBody.snapshot.id).toBe(repeatReceipt.id);
    expect(readBody.snapshot.effectivePolicyHash).toBe(runReceipt.effectivePolicyHash);

    const crossOrg = await runWithOrgScope(pool, ORG_B, (client) =>
      client.query("SELECT id FROM effective_policy_snapshots WHERE project_id = $1", [PROJECT_A]),
    );
    expect(crossOrg.rows).toEqual([]);

    const loaded = await runWithOrgScope(pool, ORG_A, (client) =>
      getEffectivePolicySnapshot(client, ORG_A, PROJECT_A, "run", "run_governance_receipt_a"),
    );
    expect(loaded?.bindingId).toBe(secondBody.binding.id);

    const events = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query<{ event_type: string }>(
        `SELECT event_type
           FROM events
          WHERE org_id = $1 AND project_id = $2
            AND event_type IN (
              'governance.binding.activated',
              'governance.binding.superseded',
              'governance.effective_policy.recorded'
            )`,
        [ORG_A, PROJECT_A],
      ),
    );
    expect(new Set(events.rows.map((row) => row.event_type))).toEqual(
      new Set([
        "governance.binding.activated",
        "governance.binding.superseded",
        "governance.effective_policy.recorded",
      ]),
    );
    expect(events.rows.filter((row) => row.event_type === "governance.binding.superseded")).toHaveLength(1);
    expect(events.rows.filter((row) => row.event_type === "governance.binding.activated")).toHaveLength(2);
  });

  it("can provision the second tenant without exposing the first tenant's rows", async () => {
    const pool = requirePool(appPool);
    const tiers = await runWithOrgScope(pool, ORG_B, (client) =>
      createGovernanceTier(client, {
        orgId: ORG_B,
        projectId: PROJECT_B,
        tierName: "org-b-tier",
        preset: "open",
      }),
    );
    const binding = await runWithOrgScope(pool, ORG_B, (client) =>
      bindGovernanceTier(client, {
        orgId: ORG_B,
        projectId: PROJECT_B,
        tierId: requireTier(tiers).id,
        createdBy: "user_governance_bindings_b",
      }),
    );
    expect(binding.binding.projectId).toBe(PROJECT_B);
    const snapshots = await runWithOrgScope(pool, ORG_B, (client) =>
      client.query("SELECT id FROM effective_policy_snapshots WHERE org_id = $1", [ORG_B]),
    );
    expect(snapshots.rows).toHaveLength(1);
  });
});
