// RLS wave R2 cohort-2 — tasks + cost_records DAL conversion, proven against a
// REAL Postgres (no SQL mocks).
//
// R2 cohort-2 routes the tasks + cost_records read/write query sites through R1's
// org-scoped client (`runWithOrgScope` → `getOrgScopedClient()`), so each tenant
// query executes inside a `SET LOCAL app.current_org_id = <org>` transaction. It
// is INERT: still the restricted role, NO policies, so behavior is identical to
// the pool path. These tests prove that end-to-end:
//   (a) the tasks WRITE helpers (`insertChildTask` / `markTaskDone`, handed the
//       pool) route through the ambient org-scoped client inside a scope AND fall
//       back to the pool when there is none — same committed row either way;
//   (b) the cost_records WRITE recorder (`CostRecorder.record`, handed the pool)
//       does the same;
//   (c) the cost_records READ loaders (`fetchCostsPage`,
//       `fetchRunCostsForSnapshot`) return the org's rows on the org-scoped
//       client, identical to the raw pool;
//   (d) the metering READ (`getRunUsage`) returns the run's totals on the
//       org-scoped client, identical to the raw pool.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 / cohort-1 tests. Wired into `just smoke` via the
// same gate (`just smoke-rls-r2-cohort2`).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { CostRecorder } from "../src/engine/costs/recorder.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { getRunUsage } from "../src/engine/quota/index.js";
import { insertChildTask, markTaskDone } from "../src/engine/workflow/subtaskTasks.js";
import { fetchCostsPage, fetchRunCostsForSnapshot, fetchRunTasks } from "../src/routes/runs/list.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r2c2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_rls_a";
const ORG_B = "org_rls_b";
const PROJECT_A = `proj_${ORG_A}`;
const SPEC_A = `spec_${ORG_A}`;
const RUN_A = "run_a";
const PLANNER_TASK = "task_plan_a";

describeDb("RLS R2 cohort-2 — tasks + cost_records through the org-scoped client", () => {
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

    // Two orgs; only org A gets a run + a planner (parent) task so the child-task
    // INSERT has a parent to reference. Org B exists to prove the app-layer org
    // predicate still scopes reads (belt-and-suspenders).
    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(ownerPool, ORG_B, `proj_${ORG_B}`, `spec_${ORG_B}`, "run_b");
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan spec', 'running', now(), 'answerer', 'fake', NULL)`,
      [PLANNER_TASK, RUN_A, ORG_A],
    );
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

  // (a) tasks WRITE helpers route through the ambient scope, and fall back to the
  //     pool when there is none — same committed row either way.
  it("(a) insertChildTask/markTaskDone write through the ambient scope and via the pool fallback", async () => {
    // In-scope: the INSERT runs on the ambient org-scoped client. We prove that by
    // inserting inside the scope and observing the new row inside the SAME
    // transaction (only visible if the INSERT used that client).
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await insertChildTask(runtimePool, {
        taskId: "task_write_scoped",
        runId: RUN_A,
        kind: "write",
        title: "write subtask 0",
        parentTaskId: PLANNER_TASK,
        agentKind: "writer",
        cli: "fake",
        model: null,
      });
      const within = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM tasks WHERE task_id = 'task_write_scoped'",
      );
      expect(Number(within.rows[0]?.n)).toBe(1);
      // markTaskDone on the same client updates the row in the same txn.
      await markTaskDone(runtimePool, "task_write_scoped", "passed");
      const done = await client.query<{ status: string; outcome: string }>(
        "SELECT status, outcome FROM tasks WHERE task_id = 'task_write_scoped'",
      );
      expect(done.rows[0]?.status).toBe("done");
      expect(done.rows[0]?.outcome).toBe("passed");
    });

    // Out-of-scope: the same helper handed the pool falls back to the pool — the
    // row still commits (inert), proving identical behavior without a scope.
    await insertChildTask(runtimePool, {
      taskId: "task_write_pool",
      runId: RUN_A,
      kind: "write",
      title: "write subtask 1",
      parentTaskId: PLANNER_TASK,
      agentKind: "writer",
      cli: "fake",
      model: null,
    });
    const committed = await countTasks(runtimePool, "task_write_pool");
    expect(committed).toBe(1);

    // The INSERT metadata is behavior-identical to subtaskStages' contract:
    // agent_kind/cli/model carried through unchanged.
    const meta = await runtimePool.query<{ agent_kind: string; cli: string; model: string | null }>(
      "SELECT agent_kind, cli, model FROM tasks WHERE task_id = 'task_write_pool'",
    );
    expect(meta.rows[0]).toEqual({ agent_kind: "writer", cli: "fake", model: null });
  });

  // (b) the cost_records WRITE recorder routes through the ambient scope, and
  //     falls back to the pool when there is none — same committed row either way.
  it("(b) CostRecorder.record writes through the ambient scope and via the pool fallback", async () => {
    const recorder = new CostRecorder(runtimePool, new FakeEventStore());
    const tokens = {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 15,
    };
    const ctx = {
      runId: RUN_A,
      taskId: PLANNER_TASK,
      specId: SPEC_A,
      projectId: PROJECT_A,
      cli: "fake" as const,
      model: "tanren-planner",
      authRef: "fake:local",
    };

    const before = await countCosts(runtimePool, RUN_A);

    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await recorder.record(ctx, tokens, { role: "scoped" });
      const within = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM cost_records WHERE run_id = $1",
        [RUN_A],
      );
      expect(Number(within.rows[0]?.n)).toBe(before + 1);
    });

    await recorder.record(ctx, tokens, { role: "pool" });

    const after = await countCosts(runtimePool, RUN_A);
    expect(after - before).toBe(2);
  });

  // (c) cost_records READ loaders, through the org-scoped client, equal the pool.
  it("(c) cost reads via the org-scoped client match the pool, scoped to the org", async () => {
    const scopedSnap = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchRunCostsForSnapshot(client, RUN_A, ORG_A),
    );
    const poolSnap = await fetchRunCostsForSnapshot(runtimePool, RUN_A, ORG_A);
    expect(scopedSnap.map((c) => c.id)).toEqual(poolSnap.map((c) => c.id));
    expect(scopedSnap.length).toBeGreaterThan(0);

    const scopedPage = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchCostsPage(client, { runId: RUN_A, orgId: ORG_A, cursor: undefined, pageSize: undefined }),
    );
    const poolPage = await fetchCostsPage(runtimePool, {
      runId: RUN_A,
      orgId: ORG_A,
      cursor: undefined,
      pageSize: undefined,
    });
    expect(scopedPage.items.map((c) => c.id)).toEqual(poolPage.items.map((c) => c.id));

    // App-layer org predicate still scopes results: org A's id over org B's run
    // returns nothing (belt-and-suspenders), and tasks reads stay scoped too.
    const crossOrg = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchRunCostsForSnapshot(client, "run_b", ORG_A),
    );
    expect(crossOrg).toHaveLength(0);

    const scopedTasks = await runWithOrgScope(runtimePool, ORG_A, (client) => fetchRunTasks(client, RUN_A, ORG_A));
    const poolTasks = await fetchRunTasks(runtimePool, RUN_A, ORG_A);
    expect(scopedTasks.map((t) => t.taskId)).toEqual(poolTasks.map((t) => t.taskId));
  });

  // (d) the metering read returns the run's totals on the scoped client, equal to
  //     the pool path (the post-run accrual reads cost_records this way).
  it("(d) getRunUsage via the org-scoped client matches the pool", async () => {
    const scoped = await runWithOrgScope(runtimePool, ORG_A, (client) => getRunUsage(client, RUN_A));
    const pooled = await getRunUsage(runtimePool, RUN_A);
    expect(scoped).toEqual(pooled);
    expect(scoped.tokens).toBeGreaterThan(0);
  });
});

async function countTasks(pool: Pool, taskId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM tasks WHERE task_id = $1", [
    taskId,
  ]);
  return Number(rows[0]?.n ?? 0);
}

async function countCosts(pool: Pool, runId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM cost_records WHERE run_id = $1", [
    runId,
  ]);
  return Number(rows[0]?.n ?? 0);
}

// Seed an org + project + spec + run for a tenant, as the owner pool. Mirrors the
// cohort-1 test's seeder; kept local so the two cohorts stay independent.
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
    `INSERT INTO specs (spec_id, project_id, org_id, title, description)
     VALUES ($1, $2, $3, 't', 'd')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, orgId],
  );
}
