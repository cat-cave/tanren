// Plane-split P3b — the de-privilege CUTOVER proof, against a REAL Postgres (no
// SQL mocks). This is the security payoff of the wave: with remote-writes ON the
// data plane writes `events`/`cost_records` ONLY through the control plane, so
// migration 0031 DROPS those write grants from the `tanren_dataplane` role the
// `worker` container connects as. A compromised runner connecting as that role
// can no longer forge a timeline event or a cost record — Postgres itself
// rejects the INSERT.
//
// What this proves under the de-privileged `tanren_dataplane` role (the NEGATIVE
// test is the whole point):
//   (a) a direct, correctly-org-scoped INSERT INTO events is REJECTED with
//       `permission denied for table events` — the grant is actually GONE, not
//       merely RLS-filtered (RLS would yield a row-violation, NOT a privilege
//       error; we assert the privilege error specifically);
//   (b) a direct INSERT INTO cost_records is likewise REJECTED;
//   (c) the role can STILL SELECT cost_records (post-run usage accrual keeps
//       reading it) — we dropped only the writes, not the read;
//   (d) the role can STILL write the tenant tables the workflow legitimately
//       writes directly this wave — runs (the `running` transition) + tasks (the
//       subtask-loop lifecycle) — proving we did NOT over-revoke and break runs;
//   (e) for contrast, the write-capable `tanren_app` role (the control plane's
//       role) CAN insert an event under the same scope — so the deny is specific
//       to the de-privileged data-plane role, not the table or the policy.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the RLS cohort + P3a tests. Wired into
// `just smoke` via `just smoke-plane-split-p3b`.

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
  return `tanren_p3b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG = "org_p3b";
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

describeDb("plane-split P3b — the de-privileged tanren_dataplane role (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration set creates `tanren_dataplane` + drops its events /
    // cost_records write grants (0031), on top of the RLS policies (0030).
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

  // (a) THE CORE NEGATIVE TEST: a direct, correctly-org-scoped event INSERT by
  // the data-plane role is rejected for lack of the privilege (code 42501 /
  // "permission denied for table events") — proving the grant is actually gone.
  it("(a) REJECTS a direct INSERT INTO events by the data-plane role (grant dropped)", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query(
          `INSERT INTO events (run_id, spec_id, project_id, org_id, event_type, payload)
           VALUES ($1, $2, $3, $4, 'run.started', '{}'::jsonb)`,
          [RUN, SPEC, PROJECT, ORG],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // And nothing landed (owner read bypasses RLS).
    const events = await ownerPool.query("SELECT 1 FROM events WHERE run_id = $1", [RUN]);
    expect(events.rowCount).toBe(0);
  });

  // (b) Same de-privilege on cost_records writes. (The column set is the minimal
  // NOT-NULL set so the PRIVILEGE error fires, not a column/constraint error.)
  it("(b) REJECTS a direct INSERT INTO cost_records by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query(
          `INSERT INTO cost_records (run_id, task_id, project_id, org_id, cli, provider, model,
             billing_mode, cost_basis)
           VALUES ($1, $2, $3, $4, 'fake', 'fake', 'm', 'self_hosted', 'unknown')`,
          [RUN, TASK, PROJECT, ORG],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (b2) Plane-split P3c — the run-end reconcile/apportion is an UPDATE of
  // cost_records, and the data-plane role's UPDATE grant is ALSO gone (0031
  // dropped INSERT/UPDATE/DELETE). This is the exact write that failed the live
  // run at finalize before P3c routed it through the control plane; assert it is
  // rejected for the PRIVILEGE (42501), so the reconcile MUST go remote.
  it("(b2) REJECTS a direct UPDATE of cost_records by the data-plane role (reconcile path)", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE cost_records SET cost_usd = 1, cost_basis = 'ccusage' WHERE run_id = $1", [RUN]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (c) The role KEEPS the cost_records READ (post-run usage accrual reads it).
  it("(c) ALLOWS the data-plane role to SELECT cost_records (read kept)", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("SELECT count(*)::int AS n FROM cost_records WHERE run_id = $1", [RUN]),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 0 }] });
  });

  // (d) The role KEEPS the `job_queue` write — a cross-org SYSTEM table OUTSIDE
  // RLS that the data plane still writes directly (the supersede's queue cancel,
  // the worker's claim/complete/fail). Proving we did not over-revoke the role's
  // legitimate system-table reach. (The run/spec/task lifecycle writes were
  // DROPPED in P3c — migration 0035 — and are asserted rejected in the P3c test.)
  it("(d) ALLOWS the data-plane role to write job_queue (system table kept)", async () => {
    const queue = await dataPlanePool.query(
      "UPDATE job_queue SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'",
      [RUN],
    );
    // No queued job for this run was seeded, so zero rows move — but the lack of a
    // 42501 is the point: the role still HOLDS the `job_queue` write privilege.
    expect(queue.rowCount).toBe(0);
  });

  // (e) Contrast: the write-capable control-plane role (tanren_app) CAN insert an
  // event under the same scope — so the deny in (a) is the data-plane role's
  // dropped grant, NOT the table or the policy. (This is the write the control
  // plane's /internal/append-event endpoint performs server-side.)
  it("(e) the control-plane tanren_app role CAN insert the same event (contrast)", async () => {
    await inOrgScope(appPool, (client) =>
      client.query(
        `INSERT INTO events (run_id, spec_id, project_id, org_id, event_type, payload)
         VALUES ($1, $2, $3, $4, 'run.started', '{}'::jsonb)`,
        [RUN, SPEC, PROJECT, ORG],
      ),
    );
    const events = await ownerPool.query("SELECT 1 FROM events WHERE run_id = $1", [RUN]);
    expect(events.rowCount).toBe(1);
  });
});
