// Issue #827 / CX-005: DirectRunStateWriter tenant task writes must FAIL CLOSED
// when no org can be resolved (explicit orgId or ambient getJobOrgId). The old
// bare-pool fallback is removed — an unscoped task op must not touch `this.pool`.
//
// DB-free: a fake pool records which receiver (pool vs scoped client) saw each
// statement, mirroring rlsR2WriteRouting / orgScopeResolvers.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { MissingOrgScopeError } from "../src/engine/data/orgScopedDb.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";

interface FakePool {
  pool: pg.Pool;
  onPool: string[];
  onClient: string[];
  connects: number;
}

function fakePool(): FakePool {
  const onPool: string[] = [];
  const onClient: string[] = [];
  const state = { connects: 0 };
  const scopedClient = {
    query: async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
      onClient.push(sql);
      // applyUpdateTaskWithEvent may SELECT after UPDATE; empty rows keep it no-op-safe.
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    query: async (sql: string) => {
      onPool.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      state.connects += 1;
      return scopedClient;
    },
  };
  return {
    pool: pool as unknown as pg.Pool,
    onPool,
    onClient,
    get connects() {
      return state.connects;
    },
  };
}

const insertInput = {
  taskId: "task_scope_1",
  runId: "run_scope_1",
  kind: "write",
  title: "write",
  status: "running",
  agentKind: "writer",
  cli: "fake",
  model: null,
  setStartedAt: true,
  attempt: 1,
};

const isTaskInsert = (sql: string): boolean => sql.includes("INSERT INTO tasks");
const isTaskUpdate = (sql: string): boolean => sql.trim().startsWith("UPDATE tasks");
const isAuthRefUpdate = (sql: string): boolean => sql.includes("auth_ref");

describe("DirectRunStateWriter — fail-closed tenant task scope (#827)", () => {
  it("insertTask THROWS MissingOrgScopeError with no org and never hits bare pool", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await expect(writer.insertTask(insertInput)).rejects.toThrow(MissingOrgScopeError);
    expect(fp.onPool.filter(isTaskInsert)).toHaveLength(0);
    expect(fp.onClient.filter(isTaskInsert)).toHaveLength(0);
    expect(fp.connects).toBe(0);
  });

  it("updateTask THROWS MissingOrgScopeError with no org and never hits bare pool", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await expect(writer.updateTask({ taskId: "task_x", transition: "running" })).rejects.toThrow(MissingOrgScopeError);
    expect(fp.onPool.filter(isTaskUpdate)).toHaveLength(0);
    expect(fp.onClient.filter(isTaskUpdate)).toHaveLength(0);
    expect(fp.connects).toBe(0);
  });

  it("setRunAuthRef THROWS MissingOrgScopeError with no org and never hits bare pool", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await expect(writer.setRunAuthRef({ runId: "run_x", authRef: "cred:1" })).rejects.toThrow(MissingOrgScopeError);
    expect(fp.onPool.filter(isAuthRefUpdate)).toHaveLength(0);
    expect(fp.onClient.filter(isAuthRefUpdate)).toHaveLength(0);
    expect(fp.connects).toBe(0);
  });

  it("supersedeQueuedPlannerTask THROWS MissingOrgScopeError with no org and never hits bare pool", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await expect(writer.supersedeQueuedPlannerTask({ runId: "run_x" })).rejects.toThrow(MissingOrgScopeError);
    expect(fp.onPool.filter(isTaskUpdate)).toHaveLength(0);
    expect(fp.onClient.filter(isTaskUpdate)).toHaveLength(0);
    expect(fp.connects).toBe(0);
  });

  it("updateTaskWithEvent THROWS MissingOrgScopeError with no org and never hits bare pool", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await expect(
      writer.updateTaskWithEvent({
        task: { taskId: "task_x", transition: "done", outcome: "passed" },
        event: {
          runId: "run_x",
          taskId: "task_x",
          specId: "spec_x",
          projectId: "proj_x",
          orgId: "org_acme",
          eventType: "task.completed",
          payload: { taskKind: "write" } as never,
        },
      }),
    ).rejects.toThrow(MissingOrgScopeError);
    expect(fp.onPool).toHaveLength(0);
    expect(fp.connects).toBe(0);
  });

  it("insertTask with explicit orgId opens runWithOrgScope (scoped client, not bare pool)", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await writer.insertTask({ ...insertInput, orgId: "org_acme" });
    expect(fp.onClient.filter(isTaskInsert)).toHaveLength(1);
    expect(fp.onPool.filter(isTaskInsert)).toHaveLength(0);
    expect(fp.connects).toBe(1);
  });

  it("insertTask with ambient job org (no explicit orgId) opens runWithOrgScope", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await runWithJobOrgId("org_job", () => writer.insertTask(insertInput));
    expect(fp.onClient.filter(isTaskInsert)).toHaveLength(1);
    expect(fp.onPool.filter(isTaskInsert)).toHaveLength(0);
    expect(fp.connects).toBe(1);
  });

  it("updateTask with explicit orgId routes to scoped client", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await writer.updateTask({ taskId: "task_x", orgId: "org_acme", transition: "running" });
    expect(fp.onClient.filter(isTaskUpdate)).toHaveLength(1);
    expect(fp.onPool.filter(isTaskUpdate)).toHaveLength(0);
  });

  it("explicit orgId wins over ambient job org for the SET LOCAL GUC", async () => {
    const clientSql: string[] = [];
    const client = {
      query: async (sql: string) => {
        clientSql.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    } as unknown as pg.Pool;
    const writer = new DirectRunStateWriter(pool);
    await runWithJobOrgId("org_job", () => writer.insertTask({ ...insertInput, orgId: "org_explicit" }));
    expect(clientSql).toContain("SET LOCAL app.current_org_id = 'org_explicit'");
    expect(clientSql.some((s) => s.includes("org_job"))).toBe(false);
  });

  it("updateTask with ambient job org routes to scoped client (not bare pool)", async () => {
    const fp = fakePool();
    const writer = new DirectRunStateWriter(fp.pool);
    await runWithJobOrgId("org_job", () =>
      writer.updateTask({ taskId: "task_x", transition: "done", outcome: "passed" }),
    );
    expect(fp.onClient.filter(isTaskUpdate)).toHaveLength(1);
    expect(fp.onPool.filter(isTaskUpdate)).toHaveLength(0);
  });
});
