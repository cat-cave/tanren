// RLS wave R3b — the ENFORCEMENT proof, against a REAL Postgres (no SQL mocks).
//
// This is the whole point of the wave: with the policies from migration 0030
// ENABLED and the runtime connecting as the restricted `tanren_app` role
// (NOBYPASSRLS), tenant isolation is enforced AT THE DATABASE — not by an app
// filter. The migration itself turns RLS on, so this test runs the REAL
// migration (not a throwaway policy) and then proves, under `tanren_app`:
//
//   (a) org A's scope sees ZERO of org B's rows (cross-tenant read denied);
//   (b) an UNSET GUC sees ZERO rows on a tenant table (deny-by-default);
//   (c) a WITH CHECK write for the WRONG org is rejected (cross-tenant write);
//   (d) a correctly-scoped read/write behaves EXACTLY as before (no regression);
//   (e) the BYPASSRLS `tanren_system` role reads across orgs (the bootstrap /
//       reaper / cross-org-seeding carve-out);
//   (f) the SYSTEM tables (job_queue, users, sessions, …) stay OUTSIDE RLS.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the R1 / R2 / R3a cohort tests. Wired into
// `just smoke` via `just smoke-rls-r3b`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, runWithSystemScope, setSystemPool } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_rls_r3b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_a";
const ORG_B = "org_b";

describeDb("RLS R3b — DB-level tenant isolation under the flipped tanren_app role", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration enables RLS + the policies AND creates the roles.
    await migrate(ownerPool);

    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });

    // Seed two complete tenants AS THE OWNER (RLS does not apply to the table
    // owner, so the seed is unfiltered). Each org gets its own run chain.
    for (const org of [ORG_A, ORG_B]) {
      await seedTenant(ownerPool, org);
    }
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
    await appPool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // (a) cross-tenant READ is denied at the DB: org A's scope sees zero of org B.
  it("(a) org A's scope returns ZERO of org B's rows on every tenant table", async () => {
    await runWithOrgScope(appPool, ORG_A, async (client) => {
      // org A sees its OWN run but NOT org B's run.
      const ownRuns = await client.query<{ run_id: string }>("SELECT run_id FROM runs");
      expect(ownRuns.rows.map((r) => r.run_id)).toEqual([`run_${ORG_A}`]);

      const otherRun = await client.query("SELECT run_id FROM runs WHERE run_id = $1", [`run_${ORG_B}`]);
      expect(otherRun.rowCount).toBe(0);

      // The same deny holds across tenant tables — directly org-scoped AND
      // FK-scoped (forge_threads via its own org_id, organizations via id).
      for (const [table, idColumn, otherId] of [
        ["tasks", "task_id", `task_${ORG_B}`],
        ["specs", "spec_id", `spec_${ORG_B}`],
        ["projects", "project_id", `proj_${ORG_B}`],
        ["forge_threads", "id", `ft_${ORG_B}`],
        ["organizations", "id", ORG_B],
      ] as const) {
        const leak = await client.query(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1`, [otherId]);
        expect(leak.rowCount, `${table} leaked org B row`).toBe(0);
      }

      // FK-scoped: forge_turns is visible only for org A's thread.
      const turns = await client.query<{ thread_id: string }>("SELECT thread_id FROM forge_turns");
      expect(new Set(turns.rows.map((r) => r.thread_id))).toEqual(new Set([`ft_${ORG_A}`]));
    });
  });

  // (b) deny-by-default: an UNSET GUC (raw pool, no SET LOCAL) sees zero rows —
  //     because current_setting('app.current_org_id', true) is NULL and
  //     `org_id = NULL` is never true. This is the backstop a forgotten scope hits.
  it("(b) an unset GUC returns ZERO rows on a tenant table (deny-by-default)", async () => {
    const runs = await appPool.query("SELECT run_id FROM runs");
    expect(runs.rowCount).toBe(0);
    const tasks = await appPool.query("SELECT task_id FROM tasks");
    expect(tasks.rowCount).toBe(0);
    const orgs = await appPool.query("SELECT id FROM organizations");
    expect(orgs.rowCount).toBe(0);
  });

  // (c) cross-tenant WRITE is rejected by WITH CHECK: under org A's scope, an
  //     INSERT stamping org B's id is denied. (Uses `tasks` — a tenant table —
  //     so the proof never writes `events` outside the event store.)
  it("(c) a WITH CHECK write for the wrong org is rejected", async () => {
    await expect(
      runWithOrgScope(appPool, ORG_A, async (client) => {
        // Try to INSERT a task tagged for org B while scoped to org A.
        await client.query(
          `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
           VALUES ('task_wrong_org', $1, $2, 'plan', 'x', 'queued', 'answerer', 'fake', 'm')`,
          [`run_${ORG_B}`, ORG_B],
        );
      }),
    ).rejects.toThrow(/row-level security|policy/iu);

    // The wrong-org write landed nothing (owner pool = RLS-exempt ground truth).
    const orphan = await ownerPool.query("SELECT 1 FROM tasks WHERE task_id = 'task_wrong_org'");
    expect(orphan.rowCount).toBe(0);
  });

  // (d) NO REGRESSION: a correctly-scoped read returns the org's own rows, and a
  //     correctly-scoped INSERT for the SAME org succeeds — identical to pre-flip.
  //     (Uses `tasks` to avoid writing `events` outside the event store.)
  it("(d) a correctly-scoped read + write behaves exactly as before", async () => {
    await runWithOrgScope(appPool, ORG_A, async (client) => {
      const before = await client.query("SELECT count(*)::int AS n FROM tasks");
      // A same-org task INSERT is admitted by WITH CHECK.
      await client.query(
        `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
         VALUES ('task_same_org', $1, $2, 'plan', 'x', 'queued', 'answerer', 'fake', 'm')`,
        [`run_${ORG_A}`, ORG_A],
      );
      const after = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks");
      expect(after.rows[0]!.n).toBe((before.rows[0] as { n: number }).n + 1);
    });
  });

  // (e) the BYPASSRLS system role reads ACROSS orgs — the documented carve-out
  //     for the worker bootstrap, the reaper's lineage sweep, and cross-org
  //     seeding. Proven via `runWithSystemScope` bound to the system pool.
  it("(e) the tanren_system bypass pool reads across orgs (the carve-out)", async () => {
    setSystemPool(systemPool);
    try {
      const both = await runWithSystemScope(appPool, (client) =>
        client.query<{ org_id: string }>("SELECT org_id FROM runs ORDER BY org_id"),
      );
      expect(both.rows.map((r) => r.org_id)).toEqual([ORG_A, ORG_B]);
    } finally {
      setSystemPool(undefined);
    }
  });

  // (f) SYSTEM tables stay OUTSIDE RLS: job_queue is readable on the raw app pool
  //     with no org scope (the worker's cross-org claim path depends on this).
  it("(f) job_queue stays outside RLS (readable with no org scope)", async () => {
    const jobs = await appPool.query<{ org_id: string | null }>("SELECT org_id FROM job_queue ORDER BY org_id");
    expect(jobs.rows.map((r) => r.org_id)).toEqual([ORG_A, ORG_B]);
  });
});

// Seed a full tenant chain (owner pool, RLS-exempt): org → project → spec → run
// → task → event → cost_record → forge_thread → forge_turn → a queued job row.
async function seedTenant(owner: Pool, org: string): Promise<void> {
  const project = `proj_${org}`;
  const spec = `spec_${org}`;
  const run = `run_${org}`;
  const task = `task_${org}`;
  const thread = `ft_${org}`;
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name)
     VALUES ($1, 'oidc', $1, $1, $1)`,
    [org],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [project, org],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'active')`,
    [spec, project, org],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'queued')`,
    [run, spec, project, org],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
    [task, run, org],
  );
  // A seeded event via the event store (single-event-writer invariant); owner =
  // RLS-exempt, org_id derived from the project. `run.started` carries a simple
  // status payload, so it validates without run-create fields.
  await new PgEventStore(owner).append({
    runId: run,
    taskId: task,
    specId: spec,
    projectId: project,
    eventType: "run.started",
    payload: { status: "running" },
  });
  await owner.query(
    `INSERT INTO cost_records (task_id, run_id, project_id, org_id, cli, provider, model, billing_mode, cost_basis)
     VALUES ($1, $2, $3, $4, 'fake', 'fake', 'm', 'self_hosted', 'unknown')`,
    [task, run, project, org],
  );
  await owner.query(
    `INSERT INTO forge_threads (id, org_id, project_id, run_id, scope, title)
     VALUES ($1, $2, $3, $4, 'run', 'thread')`,
    [thread, org, project, run],
  );
  await owner.query(
    `INSERT INTO forge_turns (id, thread_id, turn_index, source, audience, author_kind, render)
     VALUES ($1, $2, 0, '{}'::jsonb, 'org:admin', 'forge_template', '{}'::jsonb)`,
    [`turn_${org}`, thread],
  );
  await owner.query(
    `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
     VALUES ($1, $2, 'plan', '{}'::jsonb, $3)`,
    [run, task, org],
  );
}
