// apex v35 — the worker orphan reconciler, UNIFIED to the 3-bucket model.
//
// The worker-level force-halt finalizer (`runFinalize.ts`) is the safety net for a
// GENUINELY orphaned slot: a run that died (a crash bypassing the workflow's own spec-aware
// finalize) leaving its spec `in_flight` with NO live run. THE REDESIGN: a crash is a
// TRANSIENT class, so a genuine orphan now RE-DRIVES (spec → `open`, `dag.spec.redriven`) —
// the walker re-enqueues it — rather than the old terminal `no_live_run` strand. The shared
// convergence detector bounds it WITHOUT a count: at a FIXED POINT (a spec crashing the
// IDENTICAL way, RECURRING beyond a single transient repeat — a proven cycle with no new
// information) it GENUINE-HALTS `needs_attention reason:persistent_failure`, routed through the
// shared convergence judge. A changing crash — OR a single transient repeat — re-drives UNBOUNDED.
//
// Bug-1 atomicity is preserved: a fresh queued/running SUCCESSOR run (a re-drive in flight)
// means the spec is TRANSITIONING, not orphaned — the orphan path skips it entirely.

import { describe, expect, it } from "vitest";
import { parkStrandedSpecInProcess } from "../src/engine/worker/runFinalize.js";

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
      // Each prior re-drive records the ENRICHED signature (code + the stage it failed in), so the
      // orphan reader keys on `code@stage` exactly as the live path does.
      const rows = Array.from({ length: this.opts.priorSameFailures ?? 0 }, () => ({
        payload: { failureCode: "internal", stage: "run" },
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
  /** The status the guarded `UPDATE specs SET status = ...` targeted, or undefined.
   * The atomic seam (task #48) uses a PARAMETERIZED `SET status = $2` — the target
   * status rides $2; the spec_id rides $1; the `notFromStatuses` guard rides $3.
   * Pre-#48 the orphan path used a LITERAL `SET status = '<x>'` — that shape is
   * gone now that `parkStrandedSpecInProcess` routes through the shared applier. */
  specUpdateTarget(): string | undefined {
    const q = this.queries.find((x) => x.sql.startsWith("UPDATE specs SET status"));
    if (q === undefined) return undefined;
    // Parameterized shape (atomic seam): the target status is param $2.
    if (/SET status = \$2/u.test(q.sql)) {
      const target = q.params[1];
      return typeof target === "string" ? target : undefined;
    }
    // Legacy literal shape (preserved as a fallback in case any caller still uses it).
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

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_A", "org_test", INTERNAL_FAILURE);

    // Skipped: no spec UPDATE, no event — but the successor probe DID run.
    expect(client.attemptedSpecUpdate()).toBe(false);
    expect(client.emittedEvent()).toBe(false);
    expect(client.queries.some((q) => q.sql.includes("FROM runs"))).toBe(true);
  });

  it("a GENUINELY orphaned slot (a dead run, NO successor, under the cap) is RE-DRIVEN to `open` + dag.spec.redriven", async () => {
    // No successor + no prior same-failures ⇒ first of its kind ⇒ RE-DRIVE (not a strand).
    const client = new RecordingClient({ hasSuccessor: false, occupying: true, priorSameFailures: 0 });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_dead", "org_test", INTERNAL_FAILURE);

    // The spec returned to `open` (the walker re-enqueues) — NEVER the old terminal needs_attention.
    expect(client.specUpdateTarget()).toBe("open");
    // The OBSERVABLE retry event was emitted (a re-drive, not a silent drop, not a strand).
    expect(client.emittedEvent()).toBe(true);
    expect(client.emittedEventType("dag.spec.redriven")).toBe(true);
  });

  it("a SECOND identical crash (no observable work) is NOT yet a fixed point — it RE-DRIVES (no disguised K=2)", async () => {
    // ONE prior identical `internal@run` crash + this identical one is NOT proof of a dead-end:
    // a crash has no observable produced work, so a single repeat could be a transient flake
    // recurring once. The corrected doctrine re-drives (the disguised-K=2 the audit flagged is gone).
    const client = new RecordingClient({ hasSuccessor: false, occupying: true, priorSameFailures: 1 });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_dead", "org_test", INTERNAL_FAILURE);

    expect(client.specUpdateTarget()).toBe("open");
    expect(client.emittedEventType("dag.spec.redriven")).toBe(true);
  });

  it("a spec crashing the IDENTICAL way RECURRING (a CYCLE) GENUINE-HALTS `needs_attention` (no count)", async () => {
    // TWO prior identical `internal@run` crashes + this identical one ⇒ the crash RECURS beyond
    // the immediate neighbor (a proven cycle, no new information) ⇒ persistent_failure. No
    // hardcoded attempt cap — the cycle detection itself is the loop-breaker, routed through the judge.
    const client = new RecordingClient({ hasSuccessor: false, occupying: true, priorSameFailures: 2 });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_dead", "org_test", INTERNAL_FAILURE);

    // At the proven cycle the orphan is genuinely stuck — it parks `needs_attention`, not re-drives.
    expect(client.specUpdateTarget()).toBe("needs_attention");
    expect(client.emittedEvent()).toBe(true);
    expect(client.emittedEventType("dag.spec.needs_attention")).toBe(true);
  });

  it("a spec already past occupancy (merged/open) with no successor is a no-op — no duplicate disposition", async () => {
    const client = new RecordingClient({ hasSuccessor: false, occupying: false });

    await parkStrandedSpecInProcess(client.asClient(), "spec_1", "project_1", "run_x", "org_test", INTERNAL_FAILURE);

    // The guarded UPDATE was attempted (the idempotency boundary) but matched nothing ⇒ no event.
    expect(client.attemptedSpecUpdate()).toBe(true);
    expect(client.emittedEvent()).toBe(false);
  });
});
