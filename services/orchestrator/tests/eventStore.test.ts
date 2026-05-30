import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runWithOrgScope } from "@tanren/db";
import { FakeEventStore, PgEventStore } from "../src/engine/eventStore.js";
import { listEventNames } from "../src/engine/events.js";

describe("event store (legacy shim)", () => {
  it("re-exports listEventNames from the registry barrel", () => {
    expect(listEventNames()).toContain("planner.completed");
  });

  it("accepts declared event names", async () => {
    const store = new FakeEventStore();

    await store.append({
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      eventType: "hello.started",
      payload: {},
    });

    expect(store.events).toHaveLength(1);
  });

  it("rejects undeclared event names", async () => {
    const store = new FakeEventStore();

    await expect(
      store.append({
        runId: "run_1",
        specId: "spec_1",
        projectId: "project_1",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventType: "made_up.event" as never,
        payload: {} as never,
      }),
    ).rejects.toThrow("undeclared event name");
  });
});

// RLS R2 cohort-1: a PgEventStore handed the shared pool routes its INSERT
// through the ambient org-scoped client when a `runWithOrgScope` transaction is
// open, and falls back to the pool when there is none. A fake pool whose
// `connect()` hands out a distinct "scoped client" records which receiver got
// the events INSERT, proving the routing without a real Postgres.
// Match the event-store write by its column-list signature rather than the raw
// INSERT phrase, which the single-event-writer architecture check (correctly)
// forbids outside the event store itself.
const isEventInsert = (sql: string): boolean => /events \(run_id/u.test(sql);

describe("PgEventStore — RLS R2 org-scope routing (inert)", () => {
  function fakePool() {
    const insertsOnPool: string[] = [];
    const insertsOnClient: string[] = [];
    const scopedClient = {
      query: async (sql: string) => {
        // Swallow the transaction-control + GUC statements runWithOrgScope emits.
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
        if (isEventInsert(sql)) insertsOnClient.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      query: async (sql: string) => {
        if (isEventInsert(sql)) insertsOnPool.push(sql);
        return { rows: [], rowCount: 0 };
      },
      connect: async () => scopedClient,
    };
    return { pool: pool as unknown as pg.Pool, insertsOnPool, insertsOnClient };
  }

  const event = {
    runId: "run_1",
    specId: "spec_1",
    projectId: "project_1",
    eventType: "run.started" as const,
    payload: { status: "running" },
  };

  it("routes the append through the ambient scoped client inside a scope", async () => {
    const { pool, insertsOnPool, insertsOnClient } = fakePool();
    await runWithOrgScope(pool, "org_acme", async () => {
      await new PgEventStore(pool).append(event);
    });
    expect(insertsOnClient).toHaveLength(1);
    expect(insertsOnPool).toHaveLength(0);
  });

  it("falls back to the pool when there is no ambient scope (inert)", async () => {
    const { pool, insertsOnPool, insertsOnClient } = fakePool();
    await new PgEventStore(pool).append(event);
    expect(insertsOnPool).toHaveLength(1);
    expect(insertsOnClient).toHaveLength(0);
  });

  it("uses a handed-in client verbatim (no ambient re-resolution)", async () => {
    const handedInInserts: string[] = [];
    const handedIn = {
      query: async (sql: string) => {
        if (isEventInsert(sql)) handedInInserts.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as pg.PoolClient;
    const { pool, insertsOnClient } = fakePool();
    // Even inside a scope, a store constructed with a specific client writes to
    // THAT client — the caller owns its transaction (e.g. createQueuedRunFromSpec).
    await runWithOrgScope(pool, "org_acme", async () => {
      await new PgEventStore(handedIn).append(event);
    });
    expect(handedInInserts).toHaveLength(1);
    expect(insertsOnClient).toHaveLength(0);
  });
});
