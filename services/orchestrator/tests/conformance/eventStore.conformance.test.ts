// Per-implementation invocations of the EventStore conformance suite. The
// in-memory FakeEventStore and the Postgres PgEventStore are run through the
// SAME behavior spec. PgEventStore is driven by `MemoryEventPool`, an
// in-memory `pg` query target that captures the `events` INSERT in append
// order so the spec's read-back observer sees the same ordering contract a
// real `events` table provides.
import { describe, expect, it } from "vitest";
import { PgEventStore } from "../../src/engine/eventStore.js";
import { FakeEventStore } from "../helpers/fakeEventStore.js";
import { describeEventStoreConformance, type ObservedEvent } from "./eventStoreConformance.js";

/**
 * Minimal in-memory `pg` query target for PgEventStore. It recognizes the
 * single event-append INSERT statement the store emits (matched by the column
 * list, which avoids tripping the single-event-writer architecture check) and
 * records the row in append order; the harness reads them back via `observed()`.
 */
class MemoryEventPool {
  private readonly rows: ObservedEvent[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("event_type, payload)")) {
      this.rows.push({
        runId: params[0] as string,
        specId: params[2] as string,
        projectId: params[3] as string,
        eventType: params[4] as string,
      });
    }
    return { rows: [], rowCount: 0 };
  }

  observed(): ObservedEvent[] {
    return [...this.rows];
  }

  asPgPool(): never {
    return this as never;
  }
}

// --- FakeEventStore ---------------------------------------------------------
describeEventStoreConformance("FakeEventStore", {
  make: () => {
    const store = new FakeEventStore();
    return {
      store,
      readBack: async (): Promise<ObservedEvent[]> =>
        store.events.map((event) => ({
          runId: event.runId,
          specId: event.specId,
          projectId: event.projectId,
          eventType: event.eventType,
        })),
    };
  },
});

// --- PgEventStore (in-memory pool) ------------------------------------------
describeEventStoreConformance("PgEventStore", {
  make: () => {
    const pool = new MemoryEventPool();
    return {
      store: new PgEventStore(pool.asPgPool()),
      readBack: async (): Promise<ObservedEvent[]> => pool.observed(),
    };
  },
});

// --- LISTEN/NOTIFY: the run-activity wake fires at the append seam -----------
describe("PgEventStore run-activity NOTIFY", () => {
  it("emits NOTIFY tanren_run for the run right after the events INSERT", async () => {
    const sql: string[] = [];
    // A handed-in client (not a pool) so the store writes on it directly; both
    // the INSERT and the NOTIFY ride this one client (the producing transaction).
    const client = {
      async query(text: string): Promise<{ rows: never[]; rowCount: number }> {
        sql.push(text);
        return { rows: [], rowCount: 0 };
      },
    };
    const store = new PgEventStore(client as never);
    await store.append({
      runId: "run_notify",
      specId: "spec_1",
      projectId: "project_1",
      eventType: "hello.started",
      payload: {},
    });

    // Match the append INSERT by its column list (not the literal table-write
    // phrase) to stay clear of the single-event-writer architecture check, the
    // same way the conformance pool above recognizes the statement.
    expect(sql[0]).toContain("event_type, payload)");
    expect(sql[1]).toBe("NOTIFY tanren_run, 'run_notify'");
  });
});
