// flaky quarantine-surface tests. Exercises `detectAndQuarantineFlaky`
// end to end against a small in-memory pg substitute + a fake event store (both
// TEST FIXTURES, under tests/). Proves: a proven-flaky check is RECORDED on the
// quarantine surface AND both operator-visible events fire; a consistently-
// failing check is NEVER recorded (quarantine cannot mask a broken test); and a
// second pass is idempotent (no duplicate record, no re-emitted event).

import { describe, expect, it } from "vitest";
import { detectAndQuarantineFlaky, loadCiObservations } from "../src/engine/insights/ciFlaky.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";

const PROJECT = "project_a";
const NOW = new Date("2026-05-15T00:00:00Z");

interface CiEventSeed {
  headSha: string;
  steps: Array<{ name: string; tier: string; passed: boolean }>;
  tsMs: number;
}

/** A fake event store that records every append (TEST FIXTURE only). */
class FakeEventStore {
  appended: Array<{ eventType: EventName; payload: unknown }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push({ eventType: input.eventType, payload: input.payload });
  }
}

interface QuarantineRow {
  id: string;
  project_id: string;
  check_name: string;
  test_id: string | null;
  toggled_sha_count: number;
  observation_count: number;
  evidence: unknown;
  cleared_at: Date | null;
}

/**
 * Minimal in-memory pg substitute for the two SQL shapes ciFlaky.ts emits: the
 * gate.verdict event SELECT and the quarantined_tests SELECT/INSERT. TEST FIXTURE only.
 */
class FlakyMemoryClient {
  events: CiEventSeed[] = [];
  quarantined: QuarantineRow[] = [];

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const t = sql.trim();
    if (t.startsWith("SELECT payload, ts") && t.includes("FROM events")) {
      const since = params[1] as Date;
      const rows = this.events
        .filter((e) => e.tsMs >= since.getTime())
        .sort((a, b) => a.tsMs - b.tsMs)
        .map((e) => ({ payload: { headSha: e.headSha, steps: e.steps }, ts: new Date(e.tsMs) }));
      return { rows, rowCount: rows.length };
    }
    // CI-intelligence PR2: the per-test results loader. No per-test seeds in these
    // check-level tests, so it returns empty (the check-level path is exercised).
    if (t.includes("FROM ci_test_results")) {
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith("SELECT check_name, test_id FROM quarantined_tests")) {
      const projectId = String(params[0]);
      const rows = this.quarantined
        .filter((q) => q.project_id === projectId && q.cleared_at === null)
        .map((q) => ({ check_name: q.check_name, test_id: q.test_id }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("INSERT INTO quarantined_tests")) {
      // Params: id, project_id, check_name, test_id, toggled, observation, evidence, now.
      const projectId = String(params[1]);
      const checkName = String(params[2]);
      const testId = params[3] === null ? null : String(params[3]);
      // honour the partial-unique index on coalesce(test_id, check_name).
      const target = testId ?? checkName;
      const exists = this.quarantined.some(
        (q) => q.project_id === projectId && (q.test_id ?? q.check_name) === target && q.cleared_at === null,
      );
      if (exists) return { rows: [], rowCount: 0 };
      this.quarantined.push({
        id: String(params[0]),
        project_id: projectId,
        check_name: checkName,
        test_id: testId,
        toggled_sha_count: Number(params[4]),
        observation_count: Number(params[5]),
        evidence: JSON.parse(String(params[6])),
        cleared_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

// Build a gate.verdict seed from a compact {name, conclusion} check list — a
// non-"success" conclusion maps to a failed step (a null/pending conclusion is
// dropped, mirroring the native gate which only records completed steps).
function ci(headSha: string, checkRuns: Array<{ name: string; conclusion: string | null }>, tsMs: number): CiEventSeed {
  const steps = checkRuns
    .filter((c) => c.conclusion !== null)
    .map((c) => ({ name: c.name, tier: "fast", passed: c.conclusion === "success" }));
  return { headSha, steps, tsMs };
}

describe("detectAndQuarantineFlaky — records + emits for a genuinely-flaky check", () => {
  it("quarantines the toggling check and emits ci.flaky.detected + ci.test.quarantined", async () => {
    const db = new FlakyMemoryClient();
    db.events = [
      ci("sha1", [{ name: "unit", conclusion: "failure" }], NOW.getTime() - 1000),
      ci("sha1", [{ name: "unit", conclusion: "success" }], NOW.getTime() - 500),
    ];
    const store = new FakeEventStore();
    const insights = await detectAndQuarantineFlaky(db, {
      projectId: PROJECT,
      now: NOW,
      eventStore: store,
      loadChecks: (since) => loadCiObservations(db, { projectId: PROJECT, since }),
    });

    expect(db.quarantined).toHaveLength(1);
    expect(db.quarantined[0]!.check_name).toBe("unit");
    expect(store.appended.map((a) => a.eventType)).toEqual(["ci.flaky.detected", "ci.test.quarantined"]);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.kind).toBe("ci_flaky");
    expect(insights[0]!.payload).toMatchObject({ kind: "ci_flaky", checkName: "unit", toggledShaCount: 1 });
  });
});

describe("detectAndQuarantineFlaky — SAFETY: a consistently-failing check is never quarantined", () => {
  it("does not record or emit for a check that only ever fails", async () => {
    const db = new FlakyMemoryClient();
    db.events = [
      ci("sha1", [{ name: "broken", conclusion: "failure" }], NOW.getTime() - 3000),
      ci("sha2", [{ name: "broken", conclusion: "failure" }], NOW.getTime() - 2000),
      ci("sha3", [{ name: "broken", conclusion: "failure" }], NOW.getTime() - 1000),
    ];
    const store = new FakeEventStore();
    const insights = await detectAndQuarantineFlaky(db, {
      projectId: PROJECT,
      now: NOW,
      eventStore: store,
      loadChecks: (since) => loadCiObservations(db, { projectId: PROJECT, since }),
    });

    expect(db.quarantined).toHaveLength(0);
    expect(store.appended).toHaveLength(0);
    expect(insights).toHaveLength(0);
  });

  it("a flaky check next to a broken check quarantines ONLY the flaky one", async () => {
    const db = new FlakyMemoryClient();
    db.events = [
      ci(
        "sha1",
        [
          { name: "unit", conclusion: "failure" },
          { name: "broken", conclusion: "failure" },
        ],
        NOW.getTime() - 2000,
      ),
      ci(
        "sha1",
        [
          { name: "unit", conclusion: "success" },
          { name: "broken", conclusion: "failure" },
        ],
        NOW.getTime() - 1000,
      ),
    ];
    const store = new FakeEventStore();
    await detectAndQuarantineFlaky(db, {
      projectId: PROJECT,
      now: NOW,
      eventStore: store,
      loadChecks: (since) => loadCiObservations(db, { projectId: PROJECT, since }),
    });
    expect(db.quarantined.map((q) => q.check_name)).toEqual(["unit"]);
    // broken is NOT quarantined → its failures still reach the gate.
  });
});

describe("detectAndQuarantineFlaky — idempotent", () => {
  it("a second pass does not duplicate the record or re-emit the event", async () => {
    const db = new FlakyMemoryClient();
    db.events = [
      ci("sha1", [{ name: "unit", conclusion: "failure" }], NOW.getTime() - 1000),
      ci("sha1", [{ name: "unit", conclusion: "success" }], NOW.getTime() - 500),
    ];
    const store = new FakeEventStore();
    await detectAndQuarantineFlaky(db, {
      projectId: PROJECT,
      now: NOW,
      eventStore: store,
      loadChecks: (since) => loadCiObservations(db, { projectId: PROJECT, since }),
    });
    const insights2 = await detectAndQuarantineFlaky(db, {
      projectId: PROJECT,
      now: NOW,
      eventStore: store,
      loadChecks: (since) => loadCiObservations(db, { projectId: PROJECT, since }),
    });

    // not duplicated
    expect(db.quarantined).toHaveLength(1);
    // events fired exactly once
    expect(store.appended).toHaveLength(2);
    // still surfaced as an insight on the second pass (operator keeps seeing it).
    expect(insights2).toHaveLength(1);
    expect(insights2[0]!.kind).toBe("ci_flaky");
  });
});

/**
 * A pg substitute that HARD-FAILS on any `events` query — modelling the worker's
 * `tanren_dataplane` role, which has no `events` grant. The tenant tables
 * (`ci_test_results` + `quarantined_tests`) still answer normally. TEST FIXTURE.
 */
class DataplaneMemoryClient extends FlakyMemoryClient {
  override async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("FROM events")) {
      throw new Error("permission denied for table events");
    }
    return super.query(sql, params);
  }
}

describe("detectAndQuarantineFlaky — PLANE-SPLIT: the events read never touches the work pool", () => {
  it("quarantines a flaky check on a dataplane pool that denies `events`, reading checks via loadChecks", async () => {
    // The work pool denies `events` (like the worker's de-privileged role). The check
    // observations arrive ONLY through `loadChecks` — the seam the worker wires to a
    // system-scoped client. Detection still records + emits, proving the events read
    // is fully off the work pool (no silent permission-denied at runtime).
    const db = new DataplaneMemoryClient();
    // The system-scoped reader half: a separate client that CAN read events.
    const systemReader = new FlakyMemoryClientWith([
      ci("sha1", [{ name: "unit", conclusion: "failure" }], NOW.getTime() - 1000),
      ci("sha1", [{ name: "unit", conclusion: "success" }], NOW.getTime() - 500),
    ]);
    const store = new FakeEventStore();
    const insights = await detectAndQuarantineFlaky(db, {
      projectId: PROJECT,
      now: NOW,
      eventStore: store,
      // Provided by the caller's system-scoped read — NOT the work pool.
      loadChecks: (since) => loadCiObservations(systemReader, { projectId: PROJECT, since }),
    });

    expect(db.quarantined.map((q) => q.check_name)).toEqual(["unit"]);
    expect(store.appended.map((a) => a.eventType)).toEqual(["ci.flaky.detected", "ci.test.quarantined"]);
    expect(insights).toHaveLength(1);
  });
});

/** A FlakyMemoryClient pre-seeded with check events, for the system-scoped reader half. */
class FlakyMemoryClientWith extends FlakyMemoryClient {
  constructor(seed: CiEventSeed[]) {
    super();
    this.events = seed;
  }
}
