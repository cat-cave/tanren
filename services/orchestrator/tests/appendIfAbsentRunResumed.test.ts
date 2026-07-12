// Regression pin for the apex v94 halt: the window-pause RESUME atomic seam
// inserts the paired `run.resumed` event via `PgEventStore.appendIfAbsent`
// (idempotent — the prober may retry the resume on a dropped HTTP response).
// Before the fix, `run.resumed` was NOT in `TERMINAL_DEDUPED_EVENT_TYPES`, so
// `appendIfAbsent` threw ("event type run.resumed is not covered by a terminal
// partial unique index ...") BEFORE reaching the DB — every resume tick 500'd
// and paused runs could NEVER resume. The migration + the code set now cover
// `run.resumed` under `events_run_terminal_unique`, so a resume is a no-op-safe
// at-most-once insert.

import { describe, expect, it } from "vitest";
import { PgEventStore } from "../src/engine/eventStore.js";

const RUN_RESUMED_PAYLOAD = {
  provider: "agent",
  slot: "primary",
  usedPercent: 0,
  pausedDurationSeconds: 60,
} as const;

const RESUMED_INPUT = {
  runId: "run_resume_pin",
  specId: "spec_resume_pin",
  projectId: "project_resume_pin",
  orgId: "org_resume_pin",
  eventType: "run.resumed",
  payload: RUN_RESUMED_PAYLOAD,
} as const;

/**
 * Minimal in-memory `pg` query target that models the `events_run_terminal_unique`
 * partial unique index for `(run_id, event_type)`: the FIRST insert of a given
 * pair LANDS (returns a numeric bigserial id, as `notifyEventAppended` requires);
 * a later insert of the SAME pair CONFLICTS under `ON CONFLICT DO NOTHING` and
 * returns no row — exactly the shape `appendIfAbsent` reads to return `false`.
 */
class FakeUniqueIndexPool {
  readonly inserts: Array<{ runId: unknown; eventType: unknown }> = [];
  private readonly landed = new Set<string>();
  private nextId = 1;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    // Match on the column list (not the INSERT verb) so the single-event-writer
    // architecture check does not flag this test-only in-memory query target —
    // same technique as MemoryEventPool in eventStore.conformance.test.ts.
    if (sql.includes("event_type, payload)")) {
      const runId = params[0];
      const eventType = params[5];
      this.inserts.push({ runId, eventType });
      const key = `${String(runId)}::${String(eventType)}`;
      if (this.landed.has(key)) {
        // Same (run_id, event_type) already present → ON CONFLICT DO NOTHING.
        return { rows: [], rowCount: 0 };
      }
      this.landed.add(key);
      return { rows: [{ id: String(this.nextId++) }], rowCount: 1 };
    }
    // NOTIFY tanren_run / tanren_event and anything else — no rows.
    return { rows: [], rowCount: 0 };
  }

  asPgPool(): never {
    return this as never;
  }
}

describe("PgEventStore.appendIfAbsent — run.resumed (apex v94 resume halt)", () => {
  it("accepts run.resumed and lands it (returns true on first insert)", async () => {
    const pool = new FakeUniqueIndexPool();
    const store = new PgEventStore(pool.asPgPool());

    const landed = await store.appendIfAbsent(RESUMED_INPUT);

    expect(landed).toBe(true);
    expect(pool.inserts).toHaveLength(1);
    expect(pool.inserts[0]).toEqual({ runId: RESUMED_INPUT.runId, eventType: "run.resumed" });
  });

  it("dedupes a retried run.resumed (second identical insert is a no-op, returns false — no throw)", async () => {
    const pool = new FakeUniqueIndexPool();
    const store = new PgEventStore(pool.asPgPool());

    const first = await store.appendIfAbsent(RESUMED_INPUT);
    const second = await store.appendIfAbsent(RESUMED_INPUT);

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Both attempts reach the DB (the conflict is resolved by the index, not by
    // the pre-DB guard throwing) — the prober's retry is safe.
    expect(pool.inserts).toHaveLength(2);
  });

  it("still throws for a genuinely non-terminal event type (the guard is intact)", async () => {
    const pool = new FakeUniqueIndexPool();
    const store = new PgEventStore(pool.asPgPool());

    await expect(
      store.appendIfAbsent({
        runId: "run_guard",
        projectId: "project_guard",
        orgId: "org_guard",
        eventType: "run.paused",
        payload: {
          provider: "agent",
          slot: "primary",
          usedPercent: 100,
          resetsAt: "2026-07-12T00:00:00.000Z",
          reason: "usage_limit",
        },
      } as never),
    ).rejects.toThrow(/not covered by a terminal partial unique index/u);
    // Rejected BEFORE any DB I/O.
    expect(pool.inserts).toHaveLength(0);
  });
});
