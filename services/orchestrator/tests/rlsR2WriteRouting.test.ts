// RLS R2 cohort-2: the tasks + cost_records write helpers, handed the shared
// pool, route their INSERT/UPDATE through the ambient org-scoped client when a
// `runWithOrgScope` transaction is open, and fall back to the pool when there is
// none. A fake pool whose `connect()` hands out a distinct "scoped client"
// records which receiver got the write, proving the routing without a real
// Postgres — the cohort-1 eventStore routing test, extended to cohort-2's sites.
//
// This pins the inert fallback seam (`resolveWritableClient`): a query-only stub
// (NOT a pool — no `connect`) is used verbatim, which is exactly why the
// subtaskStages / costsRecorder tests that hand such a stub stay behavior-
// identical after the conversion.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runWithOrgScope } from "@tanren/db";
import { CostRecorder } from "../src/engine/costs/recorder.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { insertChildTask, markTaskDone } from "../src/engine/workflow/subtaskTasks.js";

interface FakePool {
  pool: pg.Pool;
  onPool: string[];
  onClient: string[];
}

// A fake pool + a distinct scoped client its connect() returns. `match` selects
// the statement we care about (the task INSERT, the task UPDATE, or the
// cost_records INSERT); transaction-control + GUC statements are swallowed.
function fakePool(match: (sql: string) => boolean): FakePool {
  const onPool: string[] = [];
  const onClient: string[] = [];
  const scopedClient = {
    query: async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (match(sql)) onClient.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      if (match(sql)) onPool.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => scopedClient,
  };
  return { pool: pool as unknown as pg.Pool, onPool, onClient };
}

const isTaskInsert = (sql: string): boolean => sql.trim().startsWith("INSERT INTO tasks");
const isTaskUpdate = (sql: string): boolean => sql.trim().startsWith("UPDATE tasks SET status");
const isCostInsert = (sql: string): boolean => sql.trim().startsWith("INSERT INTO cost_records");

const childTask = {
  taskId: "task_write",
  runId: "run_1",
  kind: "write" as const,
  title: "write subtask 0",
  parentTaskId: "task_plan",
  agentKind: "writer" as const,
  cli: "fake",
  model: null,
};

describe("subtaskTasks — RLS R2 org-scope routing (inert)", () => {
  it("routes insertChildTask through the ambient scoped client inside a scope", async () => {
    const { pool, onPool, onClient } = fakePool(isTaskInsert);
    await runWithOrgScope(pool, "org_acme", async () => {
      await insertChildTask(pool, childTask);
    });
    expect(onClient).toHaveLength(1);
    expect(onPool).toHaveLength(0);
  });

  it("falls back to the pool for insertChildTask when there is no ambient scope", async () => {
    const { pool, onPool, onClient } = fakePool(isTaskInsert);
    await insertChildTask(pool, childTask);
    expect(onPool).toHaveLength(1);
    expect(onClient).toHaveLength(0);
  });

  it("routes markTaskDone through the ambient scoped client inside a scope", async () => {
    const { pool, onPool, onClient } = fakePool(isTaskUpdate);
    await runWithOrgScope(pool, "org_acme", async () => {
      await markTaskDone(pool, "task_write", "passed");
    });
    expect(onClient).toHaveLength(1);
    expect(onPool).toHaveLength(0);
  });

  it("falls back to the pool for markTaskDone when there is no ambient scope", async () => {
    const { pool, onPool, onClient } = fakePool(isTaskUpdate);
    await markTaskDone(pool, "task_write", "passed");
    expect(onPool).toHaveLength(1);
    expect(onClient).toHaveLength(0);
  });

  it("uses a handed-in query-only client verbatim (no ambient re-resolution)", async () => {
    const handedInInserts: string[] = [];
    const handedIn = {
      query: async (sql: string) => {
        if (isTaskInsert(sql)) handedInInserts.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as pg.PoolClient;
    const { pool, onClient } = fakePool(isTaskInsert);
    // Even inside a scope, a helper handed a specific client writes to THAT
    // client — exactly the subtaskStages-test stub's path, kept behavior-identical.
    await runWithOrgScope(pool, "org_acme", async () => {
      await insertChildTask(handedIn, childTask);
    });
    expect(handedInInserts).toHaveLength(1);
    expect(onClient).toHaveLength(0);
  });
});

describe("CostRecorder — RLS R2 org-scope routing (inert)", () => {
  const tokens = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  const ctx = {
    runId: "run_1",
    taskId: "task_plan",
    specId: "spec_1",
    projectId: "proj_1",
    cli: "fake" as const,
    model: "tanren-planner",
    authRef: "fake:local",
  };

  it("routes the cost_records INSERT through the ambient scoped client inside a scope", async () => {
    const { pool, onPool, onClient } = fakePool(isCostInsert);
    const recorder = new CostRecorder(pool, new FakeEventStore());
    await runWithOrgScope(pool, "org_acme", async () => {
      await recorder.record(ctx, tokens, {});
    });
    expect(onClient).toHaveLength(1);
    expect(onPool).toHaveLength(0);
  });

  it("falls back to the pool for the cost_records INSERT when there is no ambient scope", async () => {
    const { pool, onPool, onClient } = fakePool(isCostInsert);
    const recorder = new CostRecorder(pool, new FakeEventStore());
    await recorder.record(ctx, tokens, {});
    expect(onPool).toHaveLength(1);
    expect(onClient).toHaveLength(0);
  });
});
