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
  rows: (params: unknown[]) => Row[];
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
      // single-event-writer architecture guard scans for). Params:
      // [runId, taskId, specId, projectId, eventType, payloadJson].
      if (/\(run_id, task_id, spec_id, project_id, org_id, event_type, payload\)/u.test(trimmed)) {
        this.appended.push({ eventType: String(params[4]), payload: parsePayload(params[5]) });
        return { rows: [{ id: "1" }], rowCount: 1 };
      }
      if (/^(UPDATE|INSERT|DELETE)/u.test(trimmed)) {
        this.writes.push({ sql: trimmed, params });
      }
      const stub = this.stubs.find((s) => s.match(trimmed));
      const rows = stub === undefined ? [] : stub.rows(params);
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
    expect(result.run).toBeUndefined();
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
    expect(result.run).toEqual({
      runId: "run_1",
      fromStatus: "running",
      runnerId: "runner_1",
      runnerReleased: true,
    });
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

    expect(result.run?.runnerReleased).toBe(false);
    expect(result.run?.runnerId).toBeUndefined();
    expect(pool.runnerReleases()).toHaveLength(0);
    expect(pool.event("run.cancelled")?.runnerReleased).toBe(false);
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
