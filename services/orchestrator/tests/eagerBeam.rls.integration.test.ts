import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_eager_a";
const ORG_B = "org_eager_b";
const PROJECT_A = "project_eager_a";
const PROJECT_B = "project_eager_b";

function databaseName(): string {
  return `tanren_eager_beam_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function databaseUrl(database: string, app = false): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${database}`;
  if (app) {
    parsed.username = "tanren_app";
    parsed.password = appPassword;
  }
  return parsed.toString();
}

async function seed(owner: Pool, orgId: string, projectId: string): Promise<void> {
  const suffix = orgId.slice(-1);
  const specId = `spec_eager_${suffix}`;
  const runId = `run_eager_${suffix}`;
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    "INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, 'https://example.test/eager.git', $2)",
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'feature/eager', 'running')`,
    [runId, specId, projectId, orgId],
  );
}

describeDb("mq-8 merge_eager_beams FORCE RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let runtime: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: databaseUrl(database, true) });
    await seed(owner, ORG_A, PROJECT_A);
    await seed(owner, ORG_B, PROJECT_B);
  }, 60_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("allows only the owning org to retain a held beam and denies cross-org reads and writes", async () => {
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await client.query(
        `INSERT INTO merge_eager_beams
           (org_id, id, project_id, frontier_run_id, frontier_spec_id, rank, generation, state, stale_reason)
         VALUES ($1, 'beam_a', $2, 'run_eager_a', 'spec_eager_a', 1, 1, 'held', 'ancestor_head_changed')`,
        [ORG_A, PROJECT_A],
      );
      const role = await client.query<{ current_user: string }>("SELECT current_user");
      expect(role.rows[0]?.current_user).toBe("tanren_app");
    });
    await runWithOrgScope(runtime, ORG_B, async (client) => {
      const invisible = await client.query("SELECT id FROM merge_eager_beams WHERE project_id = $1", [PROJECT_A]);
      expect(invisible.rows).toEqual([]);
      const deniedWrite = await client.query(
        "UPDATE merge_eager_beams SET state = 'ready' WHERE id = 'beam_a' RETURNING id",
      );
      expect(deniedWrite.rows).toEqual([]);
    });
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      const visible = await client.query<{ state: string; stale_reason: string }>(
        "SELECT state, stale_reason FROM merge_eager_beams WHERE id = 'beam_a'",
      );
      expect(visible.rows).toEqual([{ state: "held", stale_reason: "ancestor_head_changed" }]);
    });
  });
});
