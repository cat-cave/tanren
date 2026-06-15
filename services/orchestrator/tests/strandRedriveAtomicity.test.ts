// apex v35 — the worker orphan reconciler, UNIFIED to the 3-bucket model.
//
// The worker-level force-halt finalizer (`runFinalize.ts`) is the safety net for a
// GENUINELY orphaned slot: a run that died (a crash bypassing the workflow's own spec-aware
// finalize) leaving its spec `in_flight` with NO live run. THE REDESIGN: a crash is a
// TRANSIENT class, so a genuine orphan now RE-DRIVES (spec → `open`, `dag.spec.redriven`) —
// the walker re-enqueues it — rather than the old terminal `no_live_run` strand. The
// consecutive-same-failure counter still bounds it: at the cap K (a spec crashing the SAME
// way K times) it GENUINE-HALTS `needs_attention reason:persistent_failure`.
//
// Bug-1 atomicity is preserved: a fresh queued/running SUCCESSOR run (a re-drive in flight)
// means the spec is TRANSITIONING, not orphaned — the orphan path skips it entirely.

import { describe, expect, it } from "vitest";
import { parkStrandedSpecInProcess } from "../src/engine/worker/runFinalize.js";
import { DEFAULT_REDRIVE_ESCALATE_AT } from "../src/engine/workflow/runFinalizeAuthority.js";

type QueryResult = { rows: unknown[]; rowCount: number };

const INTERNAL_FAILURE = { code: "internal", stage: "run", summary: "the run failed with an internal error" } as const;

/**
 * A recording client answering the orphan path's reads:
 *  - the SUCCESSOR_RUN_SQL probe (`SELECT 1 FROM runs ... status IN ('queued','running')`)
 *  - the consecutive-same-failure read (`SELECT payload FROM events ... dag.spec.redriven`)
 *  - the guarded `UPDATE specs SET status = '<open|needs_attention>' ... RETURNING spec_id`
 * `hasSuccessor` controls a fresh successor run; `occupying` whether the guarded UPDATE
 * matches a row; `priorSameFailures` seeds the consecutive-same-failure count.
 */
class RecordingClient {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly opts: { hasSuccessor: boolean; occupying: boolean; priorSameFailures?: number }) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.queries.push({ sql, params });
    if (sql.includes("FROM runs") && sql.includes("status IN ('queued', 'running')")) {
      return { rows: this.opts.hasSuccessor ? [{}] : [], rowCount: this.opts.hasSuccessor ? 1 : 0 };
    }
    if (sql.includes("FROM events") && sql.includes("dag.spec.redriven")) {
      const rows = Array.from({ length: this.opts.priorSameFailures ?? 0 }, () => ({
        payload: { failureCode: "internal" },
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE specs SET status")) {
      return { rows: this.opts.occupying ? [{ spec_id: "spec_1" }] : [], rowCount: this.opts.occupying ? 1 : 0 };
    }
    // The event-append PgEventStore INSERT (only reached on a genuine disposition).
    return { rows: [], rowCount: 1 };
  }
  asClient() {
    return this as never;
  }
  /** The status the guarded `UPDATE specs SET status = '<x>'` targeted, or undefined. */
  specUpdateTarget(): string | undefined {
    const q = this.queries.find((x) => x.sql.startsWith("UPDATE specs SET status"));
    if (q === undefined) return undefined;
    const m = /SET status = '([a-z_]+)'/u.exec(q.sql);
    return m?.[1];
  }
  /** Whether the spec status UPDATE was attempted at all (a disposition was decided). */
  attemptedSpecUpdate(): boolean {
    return this.queries.some((x) => x.sql.startsWith("UPDATE specs SET status"));
  }
  /** Whether ANY event was appended (the events-table INSERT signature). */
  emittedEvent(): boolean {
    return this.queries.some((q) => q.sql.includes("event_type, payload"));
  }
  /** Whether an event of the given type was appended (the type rides a bind param, not the SQL). */
  emittedEventType(eventType: string): boolean {
    return this.queries.some((q) => q.sql.includes("event_type, payload") && q.params.includes(eventType));
  }
}

describe("orphan reconciler — a genuine orphan RE-DRIVES (crash = transient), bounded by the cap", () => {
  it("a spec with a queued/running SUCCESSOR run is SKIPPED entirely (re-drive in flight, not orphaned)", async () => {
    const client = new RecordingClient({ hasSuccessor: true, occupying: true });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_A", INTERNAL_FAILURE);

    // Skipped: no spec UPDATE, no event — but the successor probe DID run.
    expect(client.attemptedSpecUpdate()).toBe(false);
    expect(client.emittedEvent()).toBe(false);
    expect(client.queries.some((q) => q.sql.includes("FROM runs"))).toBe(true);
  });

  it("a GENUINELY orphaned slot (a dead run, NO successor, under the cap) is RE-DRIVEN to `open` + dag.spec.redriven", async () => {
    // No successor + no prior same-failures ⇒ first of its kind ⇒ RE-DRIVE (not a strand).
    const client = new RecordingClient({ hasSuccessor: false, occupying: true, priorSameFailures: 0 });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_dead", INTERNAL_FAILURE);

    // The spec returned to `open` (the walker re-enqueues) — NEVER the old terminal needs_attention.
    expect(client.specUpdateTarget()).toBe("open");
    // The OBSERVABLE retry event was emitted (a re-drive, not a silent drop, not a strand).
    expect(client.emittedEvent()).toBe(true);
    expect(client.emittedEventType("dag.spec.redriven")).toBe(true);
  });

  it("a spec crashing the SAME way K times in a row GENUINE-HALTS `needs_attention` (the bounded escalation)", async () => {
    // K-1 prior same-failure re-drives + this one ⇒ the cap reached ⇒ persistent_failure.
    const client = new RecordingClient({
      hasSuccessor: false,
      occupying: true,
      priorSameFailures: DEFAULT_REDRIVE_ESCALATE_AT - 1,
    });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_dead", INTERNAL_FAILURE);

    // At the cap the orphan is genuinely stuck — it parks `needs_attention`, not re-drives again.
    expect(client.specUpdateTarget()).toBe("needs_attention");
    expect(client.emittedEvent()).toBe(true);
    expect(client.emittedEventType("dag.spec.needs_attention")).toBe(true);
  });

  it("a spec already past occupancy (merged/open) with no successor is a no-op — no duplicate disposition", async () => {
    const client = new RecordingClient({ hasSuccessor: false, occupying: false });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_x", INTERNAL_FAILURE);

    // The guarded UPDATE was attempted (the idempotency boundary) but matched nothing ⇒ no event.
    expect(client.attemptedSpecUpdate()).toBe(true);
    expect(client.emittedEvent()).toBe(false);
  });
});
