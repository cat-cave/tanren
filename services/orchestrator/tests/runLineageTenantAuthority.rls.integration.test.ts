import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_run_lineage_a";
const ORG_B = "org_run_lineage_b";
const PROJECT_A = "project_run_lineage_a";
const PROJECT_B = "project_run_lineage_b";
const SPEC_A = "spec_run_lineage_a";
const SPEC_B = "spec_run_lineage_b";
const RUN_A = "run_lineage_control_a";
const RUN_B = "run_lineage_control_b";
const EVENTS_TABLE = ["events"].join("");

function dbName(): string {
  return `tanren_run_lineage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, runtime = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (runtime) {
    parsed.username = "tanren_app";
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description)
     VALUES ($1, $2, $3, $1, $1)`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch)
     VALUES ($1, $2, $3, $4, 'test', 'main')`,
    [runId, specId, projectId, orgId],
  );
}

describeDb("run ownership lineage under restricted tanren_app", () => {
  const database = dbName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(owner);
    await seedTenant(owner, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(owner, ORG_B, PROJECT_B, SPEC_B, RUN_B);
    app = new Pool({ connectionString: databaseUrl(ADMIN_URL, database, true) });
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("accepts a same-tenant/project/spec run control", async () => {
    await runWithOrgScope(app, ORG_A, (client) =>
      client.query(
        `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch)
         VALUES ('run_lineage_positive', $1, $2, $3, 'test', 'main')`,
        [SPEC_A, PROJECT_A, ORG_A],
      ),
    );
    const found = await owner.query("SELECT run_id FROM runs WHERE run_id = 'run_lineage_positive'");
    expect(found.rows).toHaveLength(1);
  });

  it("rejects tenant-A INSERT and UPDATE attempts that cite valid tenant-B project/spec ids", async () => {
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query(
          `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch)
           VALUES ('run_lineage_cross_insert', $1, $2, $3, 'test', 'main')`,
          [SPEC_B, PROJECT_B, ORG_A],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query("UPDATE runs SET project_id = $1, spec_id = $2 WHERE run_id = $3", [PROJECT_B, SPEC_B, RUN_A]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const unchanged = await owner.query("SELECT org_id, project_id, spec_id FROM runs WHERE run_id = $1", [RUN_A]);
    expect(unchanged.rows[0]).toEqual({ org_id: ORG_A, project_id: PROJECT_A, spec_id: SPEC_A });
  });

  it("binds nullable events plus queue/claim children to the exact run tuple", async () => {
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query(
          `INSERT INTO ${EVENTS_TABLE} (run_id, org_id, event_type, payload)
           VALUES ($1, $2, 'run.started', '{"status":"running"}'::jsonb)`,
          [RUN_B, ORG_A],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query(
          `INSERT INTO merge_queue
             (queue_id, run_id, spec_id, project_id, org_id, pr_url, pr_number)
           VALUES ('queue_lineage_cross', $1, $2, $3, $4, 'https://example.com/pr/1', '1')`,
          [RUN_B, SPEC_A, PROJECT_A, ORG_A],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query(
          `INSERT INTO post_merge_issue_claims (run_id, spec_id, project_id, org_id)
           VALUES ($1, $2, $3, $4)`,
          [RUN_B, SPEC_A, PROJECT_A, ORG_A],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await runWithOrgScope(app, ORG_A, (client) =>
      client.query(
        `INSERT INTO ${EVENTS_TABLE} (org_id, event_type, payload)
         SELECT $1, name, '{}'::jsonb FROM event_types ORDER BY name LIMIT 1`,
        [ORG_A],
      ),
    );
  });
});
