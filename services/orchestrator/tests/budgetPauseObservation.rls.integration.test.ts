// GV-5 real-Postgres proof: the Budget HTTP projection reads the latest
// project-level `dag.budget.paused` event under direct org scope. A project/event
// from another tenant is invisible even when its project id is supplied.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBudgetPauseObservationReader } from "../src/engine/dag/budgetPauseObservation.js";
import { PgEventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_budget_pause_observation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_budget_pause_a";
const ORG_B = "org_budget_pause_b";
const PROJECT_A = "project_budget_pause_a";
const PROJECT_B = "project_budget_pause_b";

describeDb("PgBudgetPauseObservationReader RLS", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);
    await appendPause(ownerPool, ORG_A, PROJECT_A, 1);
    await appendPause(ownerPool, ORG_A, PROJECT_A, 2);
    await appendPause(ownerPool, ORG_B, PROJECT_B, 99);
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("returns the latest in-org walker proof and hides the other org", async () => {
    const reader = new PgBudgetPauseObservationReader(runtimePool);

    const own = await reader.latest(ORG_A, PROJECT_A);
    expect(own).toMatchObject({ eventType: "dag.budget.paused", readyHeldBack: 2 });
    expect(Date.parse(own?.observedAt ?? "")).not.toBeNaN();

    // Supplying org A's scope with org B's project id cannot reveal org B's
    // project-level event: explicit predicate + RLS both reject it.
    await expect(reader.latest(ORG_A, PROJECT_B)).resolves.toBeNull();
  });
});

async function seedTenant(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id, config)
     VALUES ($1, $1, $2, $3, '{"version":1}'::jsonb)`,
    [projectId, `https://example.com/${projectId}.git`, orgId],
  );
}

async function appendPause(pool: Pool, orgId: string, projectId: string, readyHeldBack: number): Promise<void> {
  await runWithOrgScope(pool, orgId, () =>
    new PgEventStore(pool).append({
      projectId,
      orgId,
      eventType: "dag.budget.paused",
      payload: { ceilingUsd: 50, spentUsd: 55, period: "total", readyHeldBack },
    }),
  );
}
