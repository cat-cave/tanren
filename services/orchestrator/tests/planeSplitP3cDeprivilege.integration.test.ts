// Plane-split P3c — the run/spec/task LIFECYCLE de-privilege CUTOVER proof,
// against a REAL Postgres (no SQL mocks). This is the security payoff of the
// wave: with remote-writes ON the data plane writes `runs`/`specs`/`tasks` ONLY
// through the control plane, so migration 0035 DROPS those write grants from the
// `tanren_dataplane` role the `worker` container connects as. A compromised
// runner connecting as that role can no longer force a run/spec/task transition —
// Postgres itself rejects the write.
//
// What this proves under the de-privileged `tanren_dataplane` role (the NEGATIVE
// test is the whole point):
//   (a) a direct, correctly-org-scoped UPDATE runs (the `running` transition) is
//       REJECTED with `permission denied for table runs` (42501) — the grant is
//       GONE, not merely RLS-filtered (RLS would yield a row-violation, NOT a
//       privilege error; we assert the privilege error specifically);
//   (b) a direct UPDATE specs (`in_flight`) is likewise REJECTED;
//   (c) a direct INSERT INTO tasks (the subtask/CI/review/merge lifecycle row) is
//       likewise REJECTED — and a direct UPDATE tasks too;
//   (d) the role STILL SELECTs all three tables (the worker reads runs/tasks to
//       drive the loop + load context, the dashboard reads them) — we dropped
//       only the writes, not the reads;
//   (e) for contrast, the write-capable control-plane role (`tanren_app`) CAN run
//       the SAME run/spec/task writes under the same scope — so the deny is
//       specific to the de-privileged data-plane role, NOT the table or the
//       policy. This is the write the control plane's `/internal/*` lifecycle
//       endpoints perform server-side, so the run lifecycle still works through
//       the control plane.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the RLS cohort + P3a/P3b tests. Wired into
// `just smoke` via `just smoke-plane-split-p3c`.

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@tanren/db";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const DATAPLANE_ROLE = "tanren_dataplane";
const DATAPLANE_PASSWORD = process.env["TANREN_DATAPLANE_DB_PASSWORD"] ?? "tanren_dataplane";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_p3c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_p3c";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = `run_${ORG}`;
const TASK = `task_${ORG}`;

// Run `body` inside an org-scoped transaction on the given role's pool, mirroring
// the worker's `runWithOrgScope` (SET LOCAL app.current_org_id). So a rejected
// write below is rejected for the PRIVILEGE, not for a missing org scope — the
// scope is correct; the grant is what is gone.
async function inOrgScope<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [ORG]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

describeDb("plane-split P3c — the de-privileged run/spec/task lifecycle writes (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration set creates `tanren_dataplane` (0031) and drops its
    // run/spec/task WRITE grants (0035), on top of the RLS policies (0030).
    await migrate(ownerPool);

    dataPlanePool = new Pool({ connectionString: withRole(ADMIN_URL, DATAPLANE_ROLE, DATAPLANE_PASSWORD, database) });
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });

    // Seed one org's run/spec/task as the OWNER (bypasses RLS as table owner).
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 't', 'd', 'active')`,
      [SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'main', 'queued')`,
      [RUN, SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
      [TASK, RUN, ORG],
    );
  }, 60_000);

  afterAll(async () => {
    await dataPlanePool?.end();
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

  // (a) THE CORE NEGATIVE TEST: a direct, correctly-org-scoped `running`
  // transition by the data-plane role is rejected for lack of the privilege
  // (42501 / "permission denied for table runs") — the grant is actually gone.
  it("(a) REJECTS a direct UPDATE runs (the running transition) by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [RUN]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // And nothing moved (owner read bypasses RLS).
    const still = await ownerPool.query("SELECT status FROM runs WHERE run_id = $1", [RUN]);
    expect(still.rows[0]).toMatchObject({ status: "queued" });
  });

  // (b) Same de-privilege on the spec status move (`in_flight`).
  it("(b) REJECTS a direct UPDATE specs (in_flight) by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (c) Same de-privilege on the tasks INSERT (a new lifecycle row) AND UPDATE.
  it("(c) REJECTS a direct INSERT/UPDATE tasks by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query(
          `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
           VALUES ($1, $2, $3, 'write', 'w', 'running', 'writer', 'fake', NULL)`,
          [`${TASK}_child`, RUN, ORG],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [TASK]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (d) The role KEEPS the SELECT on all three (the worker reads runs/tasks to
  // drive the loop + load context; the dashboard reads them) — reads not dropped.
  it("(d) ALLOWS the data-plane role to SELECT runs + specs + tasks (reads kept)", async () => {
    await inOrgScope(dataPlanePool, async (client) => {
      await expect(client.query("SELECT count(*)::int AS n FROM runs WHERE run_id = $1", [RUN])).resolves.toMatchObject(
        {
          rows: [{ n: 1 }],
        },
      );
      await expect(
        client.query("SELECT count(*)::int AS n FROM specs WHERE spec_id = $1", [SPEC]),
      ).resolves.toMatchObject({ rows: [{ n: 1 }] });
      await expect(
        client.query("SELECT count(*)::int AS n FROM tasks WHERE task_id = $1", [TASK]),
      ).resolves.toMatchObject({ rows: [{ n: 1 }] });
    });
  });

  // (e) Contrast: the write-capable control-plane role (tanren_app) CAN run the
  // SAME run/spec/task writes under the same scope — so the denies above are the
  // data-plane role's dropped grants, NOT the tables or the policy. These are the
  // exact writes the control plane's `/internal/*` lifecycle endpoints perform
  // server-side, so the run lifecycle STILL works through the control plane.
  it("(e) the control-plane tanren_app role CAN run the same run/spec/task writes (contrast)", async () => {
    await inOrgScope(appPool, async (client) => {
      const run = await client.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [RUN]);
      expect(run.rowCount).toBe(1);
      const spec = await client.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);
      expect(spec.rowCount).toBe(1);
      const task = await client.query(
        `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
         VALUES ($1, $2, $3, 'write', 'w', 'running', 'writer', 'fake', NULL)`,
        [`${TASK}_app`, RUN, ORG],
      );
      expect(task.rowCount).toBe(1);
    });
    // The control-plane writes landed (owner read bypasses RLS).
    const moved = await ownerPool.query("SELECT status FROM runs WHERE run_id = $1", [RUN]);
    expect(moved.rows[0]).toMatchObject({ status: "running" });
  });
});
