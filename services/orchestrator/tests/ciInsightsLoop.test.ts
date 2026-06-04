// CI-intelligence PR2: the detect-and-quarantine PER-TEST path + the read-only
// surface. Exercises `detectAndQuarantineFlaky` against an in-memory pg substitute
// seeded with `ci_test_results` rows (a TEST FIXTURE) — proving a proven-flaky
// TEST is recorded with its `test_id` (the per-test grain) and the operator events
// fire, while a consistently-failing test is never recorded. Then proves
// `surfaceActiveQuarantines` renders the active rows read-only (no write).

import { describe, expect, it } from "vitest";
import { detectAndQuarantineFlaky } from "../src/engine/insights/ciFlaky.js";
import { surfaceActiveQuarantines } from "../src/engine/insights/ciFlakySurface.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";

const PROJECT = "project_a";
const NOW = new Date("2026-05-15T00:00:00Z");

class FakeEventStore {
  appended: Array<{ eventType: EventName; payload: unknown }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push({ eventType: input.eventType, payload: input.payload });
  }
}

interface TestRowSeed {
  test_id: string;
  head_sha: string;
  outcome: string;
  duration_ms: number | null;
  retries: number;
  suite: string | null;
  observed_at: Date;
}

interface QRow {
  project_id: string;
  check_name: string;
  test_id: string | null;
  toggled_sha_count: number;
  observation_count: number;
  evidence: unknown;
  cleared_at: Date | null;
}

/** In-memory pg substitute for the per-test detect path. TEST FIXTURE only. */
class PerTestMemoryClient {
  testRows: TestRowSeed[] = [];
  quarantined: QRow[] = [];

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const t = sql.trim();
    if (t.startsWith("SELECT payload, ts") && t.includes("FROM events")) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes("FROM ci_test_results")) {
      const since = params[1] as Date;
      const rows = this.testRows
        .filter((r) => r.observed_at.getTime() >= since.getTime())
        .map((r) => ({
          test_id: r.test_id,
          file: null,
          suite: r.suite,
          head_sha: r.head_sha,
          outcome: r.outcome,
          duration_ms: r.duration_ms,
          retries: r.retries,
          observed_at: r.observed_at,
        }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT check_name, test_id FROM quarantined_tests")) {
      const rows = this.quarantined
        .filter((q) => q.project_id === String(params[0]) && q.cleared_at === null)
        .map((q) => ({ check_name: q.check_name, test_id: q.test_id }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT check_name, test_id, toggled_sha_count")) {
      const rows = this.quarantined
        .filter((q) => q.project_id === String(params[0]) && q.cleared_at === null)
        .map((q) => ({
          check_name: q.check_name,
          test_id: q.test_id,
          toggled_sha_count: q.toggled_sha_count,
          observation_count: q.observation_count,
          evidence: q.evidence,
        }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("INSERT INTO quarantined_tests")) {
      const projectId = String(params[1]);
      const checkName = String(params[2]);
      const testId = params[3] === null ? null : String(params[3]);
      const target = testId ?? checkName;
      const exists = this.quarantined.some(
        (q) => q.project_id === projectId && (q.test_id ?? q.check_name) === target && q.cleared_at === null,
      );
      if (exists) return { rows: [], rowCount: 0 };
      this.quarantined.push({
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

function tr(
  testId: string,
  headSha: string,
  outcome: string,
  offsetMs: number,
  suite: string | null = null,
): TestRowSeed {
  return {
    test_id: testId,
    head_sha: headSha,
    outcome,
    duration_ms: null,
    retries: 0,
    suite,
    observed_at: new Date(NOW.getTime() + offsetMs),
  };
}

describe("detectAndQuarantineFlaky — per-test grain", () => {
  it("records a proven-flaky TEST with its test_id + emits the events", async () => {
    const db = new PerTestMemoryClient();
    db.testRows = [
      tr("suite.flaky", "sha1", "failed", -2000, "unit"),
      tr("suite.flaky", "sha1", "passed", -1000, "unit"),
    ];
    const store = new FakeEventStore();
    const insights = await detectAndQuarantineFlaky(db, { projectId: PROJECT, now: NOW, eventStore: store });

    expect(db.quarantined).toHaveLength(1);
    expect(db.quarantined[0]!.test_id).toBe("suite.flaky");
    expect(db.quarantined[0]!.check_name).toBe("unit");
    expect(store.appended.map((a) => a.eventType)).toEqual(["ci.flaky.detected", "ci.test.quarantined"]);
    expect(insights[0]!.kind).toBe("ci_flaky");
  });

  it("SAFETY: a consistently-failing test is never recorded", async () => {
    const db = new PerTestMemoryClient();
    db.testRows = [tr("suite.broken", "sha1", "failed", -2000), tr("suite.broken", "sha2", "failed", -1000)];
    const store = new FakeEventStore();
    await detectAndQuarantineFlaky(db, { projectId: PROJECT, now: NOW, eventStore: store });
    expect(db.quarantined).toHaveLength(0);
    expect(store.appended).toHaveLength(0);
  });
});

describe("surfaceActiveQuarantines — read-only", () => {
  it("renders each active quarantine as a ci_flaky insight without writing", async () => {
    const db = new PerTestMemoryClient();
    db.quarantined = [
      {
        project_id: PROJECT,
        check_name: "unit",
        test_id: "suite.flaky",
        toggled_sha_count: 1,
        observation_count: 2,
        evidence: { sampleShas: ["sha1"], intraRunFlakyCount: 0 },
        cleared_at: null,
      },
    ];
    const insights = await surfaceActiveQuarantines(db, PROJECT);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.kind).toBe("ci_flaky");
    expect(insights[0]!.title).toContain("suite.flaky");
  });
});
