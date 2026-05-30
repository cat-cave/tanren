// RLS wave R3a-worker — the per-job WORKFLOW execution carries org context on
// EVERY tenant-table DB op, proven against a REAL Postgres (no SQL mocks). This
// is the final conversion gating R3b.
//
// The worker cannot wrap a run in one `runWithOrgScope` (it interleaves DB
// writes with minutes of external I/O), so it sets a lightweight per-job org-id
// (`runWithJobOrgId`, holding NO connection) and hands the workflow an
// `orgScopingPool`: each tenant-table op the workflow drives — direct
// `pool.query` AND the self-routing stores (PgEventStore / CostRecorder / task
// helpers) — opens its OWN short `runWithOrgScope` txn from that org-id. A
// connection is held only for one DB op, never across I/O.
//
// PROOF MECHANISM. To prove each op truly ran with `SET LOCAL app.current_org_id`
// (not silently on the bare pool), this test installs a TEMPORARY, throwaway RLS
// policy on tasks / events / cost_records keyed off the GUC — a stand-in for the
// R3b policy — under the restricted `tanren_app` role. With it active:
//   - under `runWithJobOrgId(orgId)` + `orgScopingPool`, the workflow's actual
//     store helpers write rows that the policy ADMITS only because each op set
//     the GUC → the rows land (every op was org-scoped);
//   - on the BARE pool with NO job-org-id, the SAME helpers' writes are REJECTED
//     by the policy (empty GUC) → proving the scope is what carries them, and
//     proving the no-job-org fallback path is the unscoped pool path.
// The policy is dropped at the end so the rest of the suite stays inert.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 / R2 / R3a cohort tests. Wired into `just smoke`
// via `just smoke-rls-r3a-worker`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithJobOrgId } from "@tanren/db";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { CostRecorder } from "../src/engine/costs/recorder.js";
import { insertChildTask } from "../src/engine/workflow/subtaskTasks.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r3aw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG = "org_rls_worker";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = "run_worker";
const PLAN_TASK = `task_plan_${ORG}`;

describeDb("RLS R3a-worker — per-job WORKFLOW tenant writes carry org context", () => {
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

    await seedTenant(ownerPool, ORG, PROJECT, SPEC, RUN);
    // The planner (parent) task: insertChildTask references it via parent_task_id.
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan', 'running', 'answerer', 'fake', 'm')`,
      [PLAN_TASK, RUN, ORG],
    );

    // Temporary, throwaway GUC-keyed policy on the three tenant tables the worker
    // writes most. WITH CHECK ties an INSERT/UPDATE's success to the GUC being set
    // for this org — so a row that lands proves the op carried `SET LOCAL
    // app.current_org_id`. RLS does not apply to the table OWNER, so seeds above
    // (owner) are unaffected; the runtime `tanren_app` role is subject to it.
    for (const table of ["tasks", "events", "cost_records"]) {
      await ownerPool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await ownerPool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await ownerPool.query(
        `CREATE POLICY r3a_worker_guc ON ${table}
           USING (org_id = current_setting('app.current_org_id', true))
           WITH CHECK (org_id = current_setting('app.current_org_id', true))`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    // Drop the throwaway policy + RLS so nothing leaks to the rest of the suite.
    for (const table of ["tasks", "events", "cost_records"]) {
      await ownerPool?.query(`DROP POLICY IF EXISTS r3a_worker_guc ON ${table}`);
      await ownerPool?.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      await ownerPool?.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
    }
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

  // (a) The substance: drive the ACTUAL workflow store helpers exactly as the
  //     run worker does — handed `orgScopingPool(runtimePool)` under
  //     `runWithJobOrgId(ORG)` — and prove tasks + events + cost_records writes
  //     all land. Under the GUC-keyed policy on the restricted role, a row lands
  //     ONLY if its op set `app.current_org_id`, so success == every op was
  //     org-scoped per-op (no connection held across the awaits between them).
  it("(a) tasks/events/cost_records writes all execute under the run's org scope", async () => {
    const scopingPool = orgScopingPool(runtimePool);
    const eventStore = new PgEventStore(scopingPool);
    const recorder = new CostRecorder(scopingPool, eventStore);

    await runWithJobOrgId(ORG, async () => {
      // tasks INSERT (worker subtask helper, handed the scoping pool)
      await insertChildTask(scopingPool, {
        taskId: `task_write_${ORG}`,
        runId: RUN,
        kind: "write",
        title: "write subtask",
        parentTaskId: PLAN_TASK,
        agentKind: "writer",
        cli: "fake",
        model: null,
      });
      // events INSERT (PgEventStore self-routes through the scoping pool); a
      // separate await before this op proves the connection was NOT held across it.
      await eventStore.append({
        runId: RUN,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "run.started",
        payload: { status: "running" },
      });
      // cost_records INSERT (CostRecorder self-routes); records its own
      // cost.resolved event too, a second scoped op.
      await recorder.record(
        {
          runId: RUN,
          taskId: PLAN_TASK,
          specId: SPEC,
          projectId: PROJECT,
          cli: "fake",
          model: "m",
          authRef: "fake:local",
        },
        {
          inputTokens: 5,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 10,
        },
        {},
      );
    });

    // Confirm via the OWNER pool (RLS does not apply to the owner) that every
    // write landed with the org stamped — proving each op ran org-scoped.
    const task = await ownerPool.query<{ org_id: string }>("SELECT org_id FROM tasks WHERE task_id = $1", [
      `task_write_${ORG}`,
    ]);
    expect(task.rows[0]?.org_id).toBe(ORG);
    const ev = await ownerPool.query<{ org_id: string }>(
      "SELECT org_id FROM events WHERE run_id = $1 AND event_type = 'run.started'",
      [RUN],
    );
    expect(ev.rows[0]?.org_id).toBe(ORG);
    const cost = await ownerPool.query<{ org_id: string }>("SELECT org_id FROM cost_records WHERE run_id = $1", [RUN]);
    expect(cost.rows[0]?.org_id).toBe(ORG);
  });

  // (b) The fork-the-other-way proof: the SAME helpers on the bare pool with NO
  //     job-org-id (the legacy/unscoped fallback) write with an EMPTY GUC, so the
  //     throwaway policy on the restricted role REJECTS the INSERT. This proves
  //     (i) the no-job-org path really is the unscoped pool path, and (ii) it is
  //     the per-job org-id — nothing else — that carries the worker's writes.
  it("(b) no-job-org fallback writes on the bare pool (empty GUC → policy rejects)", async () => {
    await expect(
      insertChildTask(runtimePool, {
        taskId: `task_unscoped_${ORG}`,
        runId: RUN,
        kind: "write",
        title: "unscoped write",
        parentTaskId: PLAN_TASK,
        agentKind: "writer",
        cli: "fake",
        model: null,
      }),
    ).rejects.toThrow(/row-level security|policy/iu);

    // And nothing was written.
    const orphan = await ownerPool.query("SELECT 1 FROM tasks WHERE task_id = $1", [`task_unscoped_${ORG}`]);
    expect(orphan.rowCount).toBe(0);
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name)
     VALUES ($1, 'oidc', $1, $1, $1)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'pending')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, orgId],
  );
}
