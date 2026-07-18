// Event-integrity RLS regression: prior events must stamp the supplied org_id,
// never re-derive it from projects. Run only against a migrated live database.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_event_prior_a";
const ORG_B = "org_event_prior_b";
const PROJECT_A = "project_event_prior_a";
const PROJECT_B = "project_event_prior_b";
const SPEC_A = "spec_event_prior_a";
const SPEC_B = "spec_event_prior_b";
const RUN_A = "run_event_prior_a";
const RUN_B = "run_event_prior_b";

function databaseName(): string {
  return `tanren_event_prior_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string, role?: string, password?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (role !== undefined && password !== undefined) {
    parsed.username = role;
    parsed.password = password;
  }
  return parsed.toString();
}

describeDb("PgEventStore prior events — explicit org_id under RLS", () => {
  const database = databaseName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database, APP_ROLE, APP_PASSWORD) });
    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B, SPEC_B, RUN_B);
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

  it("runs as tanren_app without superuser privileges", async () => {
    const identity = await appPool.query<{ current_user: string; rolsuper: boolean }>(
      "SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: APP_ROLE, rolsuper: false });
  });

  it("writes a prior event with the explicit org_id and returns zero rows to a foreign org", async () => {
    await runWithOrgScope(appPool, ORG_A, async (client) => {
      const inserted = await new PgEventStore(client).appendPriorIfAbsent({
        runId: RUN_A,
        specId: SPEC_A,
        projectId: PROJECT_A,
        orgId: ORG_A,
        eventType: "review.approved",
        payload: { prUrl: "https://example.com/org/repo/pull/826", prNumber: 826 },
        idempotencyKey: `${RUN_A}:review.approved`,
      });
      expect(inserted).toBe(true);
      const own = await client.query<{ org_id: string }>(
        "SELECT org_id FROM events WHERE run_id = $1 AND idempotency_key = $2",
        [RUN_A, `${RUN_A}:review.approved`],
      );
      expect(own.rows).toEqual([{ org_id: ORG_A }]);
    });

    const foreign = await runWithOrgScope(appPool, ORG_B, (client) =>
      client.query("SELECT 1 FROM events WHERE run_id = $1 AND idempotency_key = $2", [
        RUN_A,
        `${RUN_A}:review.approved`,
      ]),
    );
    expect(foreign.rowCount).toBe(0);
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    "INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, 'p', 'https://example.com/r.git', $2)",
    [projectId, orgId],
  );
  await owner.query(
    "INSERT INTO specs (spec_id, project_id, org_id, title, description, status) VALUES ($1, $2, $3, 't', 'd', 'open')",
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, orgId],
  );
}
