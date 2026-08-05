// The operator cancel-spec/cancel-run write path (workflow/cancelSpec) — the
// human-drivable control the operator API lacked (the §4 fix-soon leftover the apex
// pre-run audit surfaced). Proves:
//   - cancel a QUEUED spec → terminal `cancelled` + NOT re-enqueued (the walker treats
//     `cancelled` as terminal_blocked, like merged);
//   - cancel an IN-FLIGHT run → the run goes terminal `cancelled` + its claimed runner
//     is RELEASED (the `runners` row flips `released`) + the DAG slot frees;
//   - cancel an ALREADY-TERMINAL spec → IDEMPOTENT no-op (`cancelled: false`), not an
//     error, with NO further writes;
//   - a DEPENDENT of a cancelled spec → parked at `needs_attention` (NOT silently
//     dropped), emitting the loud `dag.spec.needs_attention` (source cancelled_ancestor).
//
// Runs against a SQL-routing fake pool (no live Postgres): `runWithOrgScope` checks out
// a client and runs the domain queries; the fake matches each by SQL and returns canned
// rows, recording every write so the transitions/releases/events can be asserted.

import { describe, expect, it } from "vitest";
import { cancelSpec } from "../src/engine/workflow/cancelSpec.js";
import { classifySpecStatus } from "../src/engine/dag/walkerPg.js";
import { RunStatus, isAllowedRunTransition } from "../src/engine/state/run.js";
import type { ActorContext } from "../src/auth/schemas.js";

interface QueryRecord {
  sql: string;
  params: unknown[];
}

interface Row {
  [key: string]: unknown;
}

/** A canned response keyed by a substring the SQL must contain. */
interface Stub {
  match: (sql: string) => boolean;
  rows: (params: unknown[], sql: string) => Row[];
}

/**
 * A fake pg.Pool whose `connect()` returns a client routing each query by SQL substring.
 * BEGIN / COMMIT / ROLLBACK / SET LOCAL are accepted as no-ops; every other query is
 * matched against the stubs (first match wins) and recorded.
 */
class FakePool {
  readonly writes: QueryRecord[] = [];
  readonly appended: { eventType: string; payload: Row }[] = [];
  constructor(private readonly stubs: Stub[]) {}

  connect() {
    const run = async (sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> => {
      const trimmed = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|NOTIFY|LISTEN|UNLISTEN)/u.test(trimmed)) {
        return { rows: [], rowCount: 0 };
      }
      // Event appends go through the PgEventStore INSERT — capture them for assertions.
      // Identified by its column list (NOT the literal table-insert string the
      // single-event-writer architecture guard scans for). Params (v68 fix):
      // [runId, taskId, specId, projectId, orgId, eventType, payloadJson].
      if (/\(run_id, task_id, spec_id, project_id, org_id, event_type, payload\)/u.test(trimmed)) {
        this.appended.push({ eventType: String(params[5]), payload: parsePayload(params[6]) });
        return { rows: [{ id: "1" }], rowCount: 1 };
      }
      if (/^(UPDATE|INSERT|DELETE)/u.test(trimmed)) {
        this.writes.push({ sql: trimmed, params });
      }
      const stub = this.stubs.find((s) => s.match(trimmed));
      const rows = stub === undefined ? [] : stub.rows(params, trimmed);
      return { rows, rowCount: rows.length };
    };
    return Promise.resolve({ query: run, release: () => {} });
  }

  asPool() {
    return this as never;
  }

  /** The status the LAST `UPDATE specs SET status = '<x>'` for a given guard wrote. */
  specUpdates(): QueryRecord[] {
    return this.writes.filter((w) => w.sql.startsWith("UPDATE specs SET status"));
  }
  runUpdates(): QueryRecord[] {
    return this.writes.filter((w) => w.sql.startsWith("UPDATE runs SET status"));
  }
  runnerReleases(): QueryRecord[] {
    return this.writes.filter((w) => w.sql.startsWith("UPDATE runners SET status = 'released'"));
  }
  event(type: string): Row | undefined {
    return this.appended.find((e) => e.eventType === type)?.payload;
  }
}

function parsePayload(raw: unknown): Row {
  if (typeof raw === "string") {
    return JSON.parse(raw) as Row;
  }
  return (raw ?? {}) as Row;
}

const ADMIN: ActorContext = {
  userId: "user_admin",
  orgId: "org_1",
  scopes: ["org:admin", "org:member"],
} as unknown as ActorContext;

/** Stub: the initial `SELECT project_id, status FROM specs` returns the given spec status. */
function specLoad(status: string): Stub {
  return {
    match: (sql) => sql.startsWith("SELECT project_id, status FROM specs"),
    rows: () => [{ project_id: "project_1", status }],
  };
}

describe("cancelSpec — operator cancel-spec/cancel-run", () => {
  it("cancels a QUEUED spec: terminal cancelled + the walker treats it as terminal (not re-enqueued)", async () => {
    const pool = new FakePool([
      specLoad("open"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      // No active run, no dependents.
      { match: (s) => s.includes("FROM runs"), rows: () => [] },
    ]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    expect(result.cancelled).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.runs).toEqual([]);
    // The spec was flipped to the terminal status...
    expect(pool.specUpdates()[0]?.sql).toContain("status = 'cancelled'");
    // ...and the walker classifies `cancelled` as terminal_blocked — never re-enqueued.
    expect(classifySpecStatus("cancelled")).toBe("terminal_blocked");
    // The actor-stamped audit event fired.
    expect(pool.event("spec.cancelled")?.cancelledBy).toBe("user_admin");
  });

  it("cancels an IN-FLIGHT run: run goes terminal + its claimed runner is RELEASED (no leak)", async () => {
    const pool = new FakePool([
      specLoad("in_flight"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      // The active run (locked FOR UPDATE) — running.
      {
        match: (s) => s.includes("FROM runs") && s.includes("FOR UPDATE"),
        rows: () => [{ run_id: "run_1", status: "running" }],
      },
      // The run's claimed runner.
      {
        match: (s) => s.includes("FROM runners") && s.includes("status = 'claimed'"),
        rows: () => [{ runner_id: "runner_1" }],
      },
      // No dependents.
      { match: (s) => s.startsWith("UPDATE specs SET status = 'needs_attention'"), rows: () => [] },
    ]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    expect(result.cancelled).toBe(true);
    expect(result.runs).toEqual([
      { runId: "run_1", fromStatus: "running", runnerId: "runner_1", runnerReleased: true },
    ]);
    // The run was transitioned terminal...
    expect(pool.runUpdates()[0]?.sql).toContain("status = 'cancelled'");
    // ...and the runner row was RELEASED (the allocator-release seam's DB side → the
    // reaper reclaims the sandbox now the run is terminal; NO leaked sandbox).
    expect(pool.runnerReleases()).toHaveLength(1);
    expect(pool.runnerReleases()[0]?.params).toEqual(["runner_1"]);
    // The run.cancelled audit records the release honestly.
    expect(pool.event("run.cancelled")?.runnerReleased).toBe(true);
  });

  it("records runnerReleased=false when the active run had no claimed runner (loud, never assumed)", async () => {
    const pool = new FakePool([
      specLoad("in_flight"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      {
        match: (s) => s.includes("FROM runs") && s.includes("FOR UPDATE"),
        rows: () => [{ run_id: "run_1", status: "queued" }],
      },
      // No claimed runner (a still-queued run never allocated one).
      { match: (s) => s.includes("FROM runners"), rows: () => [] },
      { match: (s) => s.startsWith("UPDATE specs SET status = 'needs_attention'"), rows: () => [] },
    ]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    expect(result.runs[0]?.runnerReleased).toBe(false);
    expect(result.runs[0]?.runnerId).toBeUndefined();
    expect(pool.runnerReleases()).toHaveLength(0);
    expect(pool.event("run.cancelled")?.runnerReleased).toBe(false);
  });

  // REGRESSION — `cancelActiveRun` selected `... status IN ('queued','running','halted')
  // ORDER BY run_id LIMIT 1` under a comment asserting it found "the (at most one) active
  // run". That premise is false: `halted` is non-terminal and ACCUMULATES (the re-drive
  // boundary reopens the spec and starts a successor, leaving the predecessor `halted`),
  // so a re-driven spec has many. `run_id` is a random-suffixed text id, so LIMIT 1 over
  // its lexicographic order picked ARBITRARILY. Observed live: 7 non-terminal rows, and
  // the cancel reported success against a day-old `halted` run while the actually-running
  // one kept going for another six minutes. The spec goes terminal in the same
  // transaction, so the retry is a no-op — one wrong pick is permanent.
  it("cancels EVERY non-terminal run, not an arbitrary one — the live run cannot be missed", async () => {
    // The observed shape: six accumulated `halted` predecessors plus the one that is
    // actually executing. The live run is NEWEST, so it sorts LAST — exactly the case a
    // `LIMIT 1` gets wrong.
    const runRows = [
      { run_id: "run_ffff01", status: "halted", started_at: "2026-08-01T00:00:00Z" },
      { run_id: "run_00aa02", status: "halted", started_at: "2026-08-01T01:00:00Z" },
      { run_id: "run_zz0003", status: "halted", started_at: "2026-08-01T02:00:00Z" },
      { run_id: "run_1ee0bd", status: "halted", started_at: "2026-08-01T03:00:00Z" },
      { run_id: "run_aa0005", status: "halted", started_at: "2026-08-01T04:00:00Z" },
      { run_id: "run_770006", status: "halted", started_at: "2026-08-02T00:00:00Z" },
      { run_id: "run_live07", status: "running", started_at: "2026-08-02T06:00:00Z" },
    ];
    const pool = new FakePool([
      specLoad("in_flight"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      {
        match: (s) => s.includes("FROM runs") && s.includes("FOR UPDATE"),
        // The fake applies the production predicate rather than asserting a hard-coded
        // set, so it can never be more correct than the SQL under test.
        rows: (_params, sql) => {
          const targeted = /status IN \(([^)]*)\)/u.exec(sql);
          const wanted = new Set((targeted?.[1] ?? "").split(",").map((part) => part.trim().replaceAll("'", "")));
          return runRows.filter((row) => wanted.has(row.status));
        },
      },
      // Only the live run still holds a claimed runner; the halted predecessors' runners
      // went back to the pool long ago.
      {
        match: (s) => s.includes("FROM runners") && s.includes("status = 'claimed'"),
        rows: (params) => (params[0] === "run_live07" ? [{ runner_id: "runner_live" }] : []),
      },
      { match: (s) => s.startsWith("UPDATE specs SET status = 'needs_attention'"), rows: () => [] },
    ]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    // NEGATIVE CONTROL: no non-terminal run of the cancelled spec survives. This is the
    // property the operator actually depends on — "a run was cancelled" is not the same
    // claim as "the run that was burning credits stopped". A single-row cancel satisfies
    // the first and fails the second.
    const cancelledIds = new Set(result.runs.map((run) => run.runId));
    const survivors = runRows.filter((row) => !cancelledIds.has(row.run_id));
    expect(survivors).toEqual([]);

    // The live run is IN the set, with its runner released.
    expect(result.runs).toContainEqual({
      runId: "run_live07",
      fromStatus: "running",
      runnerId: "runner_live",
      runnerReleased: true,
    });
    // Every run was actually transitioned, and each got its own audit event.
    expect(pool.runUpdates()).toHaveLength(7);
    expect(pool.appended.filter((e) => e.eventType === "run.cancelled")).toHaveLength(7);
    // Oldest-first, by `started_at` — a real recency signal, unlike the id's arbitrary
    // lexicographic order (which would have put `run_00aa02` first and `run_zz0003` last).
    expect(result.runs.map((run) => run.runId)).toEqual(runRows.map((row) => row.run_id));
  });

  it("cancels a PAUSED run — the state machine calls operator-cancel its only terminal exit", async () => {
    // `paused` is non-terminal (`allowedRunTransitions.paused = ["halted", "cancelled"]`)
    // and `state/run.ts` states "the operator-cancel path is the only `paused`-terminal
    // exit" — but `paused` was absent from the cancel's predicate, so the sole documented
    // exit did not select the status it was the exit for. A paused run was unreachable.
    const pool = new FakePool([
      specLoad("in_flight"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      {
        match: (s) => s.includes("FROM runs") && s.includes("FOR UPDATE"),
        rows: (_params, sql) => (sql.includes("'paused'") ? [{ run_id: "run_p", status: "paused" }] : []),
      },
      { match: (s) => s.includes("FROM runners"), rows: () => [] },
      { match: (s) => s.startsWith("UPDATE specs SET status = 'needs_attention'"), rows: () => [] },
    ]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    expect(result.runs.map((run) => run.fromStatus)).toEqual(["paused"]);
    expect(pool.event("run.cancelled")?.runId).toBe("run_p");
  });

  it("DRIFT GUARD: the predicate is exactly the non-terminal half of the run state machine", async () => {
    // Derived, not hard-coded: a status is non-terminal iff it may still transition to
    // `cancelled`. If a new non-terminal run status is added and this predicate is not
    // extended, that status can no longer be cancelled — the `paused` bug, again. This fails
    // here instead of stranding a run in production.
    let observed = "";
    const pool = new FakePool([
      specLoad("in_flight"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      {
        match: (s) => {
          if (s.includes("FROM runs") && s.includes("FOR UPDATE")) {
            observed = s;
            return true;
          }
          return false;
        },
        rows: () => [],
      },
    ]);

    await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    const nonTerminal = RunStatus.options.filter((status) => isAllowedRunTransition(status, "cancelled"));
    const targeted = /status IN \(([^)]*)\)/u.exec(observed);
    const inPredicate = (targeted?.[1] ?? "").split(",").map((part) => part.trim().replaceAll("'", ""));
    expect([...inPredicate].sort()).toEqual([...nonTerminal].sort());
    // And it selects the SET, never one arbitrary member.
    expect(observed).not.toContain("LIMIT 1");
    expect(observed).not.toContain("ORDER BY run_id");
  });

  it("is an IDEMPOTENT no-op on an already-cancelled spec (not an error, no writes)", async () => {
    const pool = new FakePool([specLoad("cancelled")]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    expect(result.cancelled).toBe(false);
    expect(result.status).toBe("cancelled");
    // No flip, no run cancel, no runner release, no event — a clean no-op.
    expect(pool.writes).toHaveLength(0);
    expect(pool.appended).toHaveLength(0);
  });

  it("is an IDEMPOTENT no-op on a merged spec (a settled terminal is never re-cancelled)", async () => {
    const pool = new FakePool([specLoad("merged")]);
    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);
    expect(result.cancelled).toBe(false);
    expect(result.status).toBe("merged");
    expect(pool.writes).toHaveLength(0);
  });

  it("parks a live DEPENDENT at needs_attention (never silently dropped) + emits the loud event", async () => {
    const pool = new FakePool([
      specLoad("in_flight"),
      { match: (s) => s.startsWith("UPDATE specs SET status = 'cancelled'"), rows: () => [{ spec_id: "spec_1" }] },
      // No active run.
      { match: (s) => s.includes("FROM runs") && s.includes("FOR UPDATE"), rows: () => [] },
      // One live dependent gets parked (the guarded UPDATE RETURNs it).
      {
        match: (s) => s.startsWith("UPDATE specs SET status = 'needs_attention'"),
        rows: () => [{ spec_id: "spec_dependent" }],
      },
    ]);

    const result = await cancelSpec(pool.asPool(), { specId: "spec_1" }, ADMIN);

    expect(result.dependentsParked).toEqual(["spec_dependent"]);
    // The dependent was escalated to needs_attention (a human decision), NOT cancelled.
    const parkWrite = pool.writes.find((w) => w.sql.startsWith("UPDATE specs SET status = 'needs_attention'"));
    expect(parkWrite?.sql).toContain("$1 = ANY(depends_on)");
    // ...and the loud dag.spec.needs_attention fired with the cancelled-ancestor source.
    const na = pool.appended.find(
      (e) => e.eventType === "dag.spec.needs_attention" && e.payload.specId === "spec_dependent",
    );
    expect(na?.payload.source).toBe("cancelled_ancestor");
    expect(na?.payload.cancelledAncestorSpecId).toBe("spec_1");
    // The spec.cancelled audit records the parked dependents.
    expect(pool.event("spec.cancelled")?.dependentsParked).toEqual(["spec_dependent"]);
  });

  it("throws SpecNotFoundError for a spec invisible under the org scope (fail-closed)", async () => {
    const pool = new FakePool([{ match: (s) => s.startsWith("SELECT project_id, status FROM specs"), rows: () => [] }]);
    await expect(cancelSpec(pool.asPool(), { specId: "spec_missing" }, ADMIN)).rejects.toThrow("spec not found");
  });
});
