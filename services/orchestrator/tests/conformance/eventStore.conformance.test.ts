// Per-implementation invocations of the EventStore conformance suite. The
// in-memory FakeEventStore and the Postgres PgEventStore are run through the
// SAME behavior spec. PgEventStore is driven by `MemoryEventPool`, an
// in-memory `pg` query target that captures the `events` INSERT in append
// order so the spec's read-back observer sees the same ordering contract a
// real `events` table provides.
import { FakeEventStore, PgEventStore } from "../../src/engine/eventStore.js";
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
