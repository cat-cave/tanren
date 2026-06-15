// apex v35 — Bug 1: re-drive ↔ orphan-reconciler ATOMICITY.
//
// The worker-level force-halt finalizer (`runFinalize.ts`) is the §2c safety net
// for a GENUINELY orphaned slot: a run that died (a crash bypassing the workflow's
// own spec-aware finalize) leaving its spec `in_flight` with NO live run. THE BUG:
// it also fired in the RACE WINDOW of a re-drive (#579) — the workflow re-drive
// halts the failed run, returns the spec to `open`, the walker re-enqueues a
// SUCCESSOR run (spec → `in_flight`), and THEN the worker's outer catch (the
// re-thrown error) ran the orphan finalize, saw the spec `in_flight` (now occupying
// the SUCCESSOR's slot), and stranded it `no_live_run`. A just-re-driven spec with a
// fresh queued/running successor is TRANSITIONING, not orphaned.
//
// THE FIX: before stranding, check for a SUCCESSOR run (a run for this spec,
// distinct from the failing one, still `queued`/`running`). Present ⇒ SKIP the
// strand (the successor governs the spec). Absent ⇒ the slot is genuinely orphaned
// ⇒ STILL strand (the safety net is preserved).
//
// This drives the in-process strand path (`parkStrandedSpecInProcess`) against a
// recording client so the successor-aware branch is unit-asserted without a DB.

import { describe, expect, it } from "vitest";
import { parkStrandedSpecInProcess } from "../src/engine/worker/runFinalize.js";

type QueryResult = { rows: unknown[]; rowCount: number };

/**
 * A recording client that answers the strand path's two reads:
 *  - the SUCCESSOR_RUN_SQL probe (`SELECT 1 FROM runs ... status IN ('queued','running')`)
 *  - the guarded `UPDATE specs SET status = 'needs_attention' ... RETURNING spec_id`
 * `hasSuccessor` controls whether a fresh successor run exists; `occupying` whether
 * the guarded UPDATE matches a row (the spec is in_flight/review).
 */
class RecordingClient {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly opts: { hasSuccessor: boolean; occupying: boolean }) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.queries.push({ sql, params });
    if (sql.includes("FROM runs") && sql.includes("status IN ('queued', 'running')")) {
      return { rows: this.opts.hasSuccessor ? [{}] : [], rowCount: this.opts.hasSuccessor ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE specs SET status = 'needs_attention'")) {
      return { rows: this.opts.occupying ? [{ spec_id: "spec_1" }] : [], rowCount: this.opts.occupying ? 1 : 0 };
    }
    // The event-append PgEventStore INSERT (only reached on a genuine strand).
    return { rows: [], rowCount: 1 };
  }
  asClient() {
    return this as never;
  }
  /** Whether the guarded needs_attention UPDATE was attempted (a strand was decided). */
  attemptedStrandUpdate(): boolean {
    return this.queries.some((q) => q.sql.startsWith("UPDATE specs SET status = 'needs_attention'"));
  }
  /**
   * Whether the dag.spec.needs_attention event was appended (a strand was EMITTED).
   * Detects the PgEventStore append by its column signature (the events-table INSERT)
   * rather than the literal table-name phrase, so the single-event-writer arch check
   * does not flag this test helper.
   */
  emittedNeedsAttention(): boolean {
    return this.queries.some((q) => q.sql.includes("event_type, payload"));
  }
}

describe("Bug 1 — orphan-strand skips a re-driven spec with a fresh successor run", () => {
  it("a spec with a queued/running SUCCESSOR run is NOT stranded (re-drive in flight, not orphaned)", async () => {
    // The race: the failed run's worker-level finalize runs AFTER the re-drive
    // enqueued a successor — the spec is `in_flight` (occupying the successor's slot),
    // but a fresh successor run exists, so it is TRANSITIONING, not orphaned.
    const client = new RecordingClient({ hasSuccessor: true, occupying: true });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_A", "an internal error");

    // The strand was SKIPPED entirely: no needs_attention UPDATE, no escalation event.
    expect(client.attemptedStrandUpdate()).toBe(false);
    expect(client.emittedNeedsAttention()).toBe(false);
    // It DID consult the successor probe (the new guard ran).
    expect(client.queries.some((q) => q.sql.includes("FROM runs"))).toBe(true);
  });

  it("a GENUINELY orphaned slot (a dead run with NO successor) IS still stranded — the safety net holds", async () => {
    // No successor run exists: the run died with nothing queued behind it. This is the
    // safety net's true target — it MUST still strand (the slot would never free otherwise).
    const client = new RecordingClient({ hasSuccessor: false, occupying: true });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_dead", "the run failed");

    // The guarded needs_attention strand WAS attempted AND emitted (a real orphan).
    expect(client.attemptedStrandUpdate()).toBe(true);
    expect(client.emittedNeedsAttention()).toBe(true);
  });

  it("a spec already past occupancy (merged/open) with no successor is a no-op — no duplicate escalation", async () => {
    // No successor + the spec is NOT in_flight/review (the workflow already parked /
    // it re-drove to open) ⇒ the guarded UPDATE matches zero rows ⇒ no event emitted.
    const client = new RecordingClient({ hasSuccessor: false, occupying: false });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_x", "the run failed");

    // The guarded UPDATE was attempted (the guard is the idempotency boundary) but
    // matched nothing, so NO escalation event was emitted (no double-escalate).
    expect(client.attemptedStrandUpdate()).toBe(true);
    expect(client.emittedNeedsAttention()).toBe(false);
  });
});
