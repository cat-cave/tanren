// Mutation-ratchet behavior tests for the DORA reducer + DB loader
// (`engine/insights/dora/compute.ts`). The pure reducer is asserted against
// hand-built rows for the median even/odd cases, the negative-gap filter, the
// deploy-frequency divisor, the change-failure ratio + each boundary status,
// and the totals envelope. The loader (`computeDoraMetrics`) is driven through
// a recording fake pool so the window/`since` math + the three result mappers
// are exercised (closing the 22 no-coverage mutants in that file).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  computeDoraMetrics,
  deriveDoraMetrics,
  type DeriveOptions,
  type DoraInputs,
} from "../src/engine/insights/dora/index.js";

const WINDOW_END = new Date("2026-05-28T00:00:00.000Z");
const WINDOW_DAYS = 30;
const WINDOW_START = new Date(WINDOW_END.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
const OPTIONS: DeriveOptions = {
  projectId: "project_a",
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  windowDays: WINDOW_DAYS,
};
const EMPTY: DoraInputs = { merges: [], finishedRuns: [], recoveries: [] };

function at(iso: string): Date {
  return new Date(iso);
}

describe("deriveDoraMetrics — median behavior", () => {
  it("averages the two middle values for an EVEN sample (lead time)", () => {
    // 1h,2h,3h,4h -> median (2h+3h)/2 = 2.5h = 9000s. Catches the even-branch
    // `(sorted[mid-1]+sorted[mid])/2` arithmetic.
    const merges = [1, 2, 3, 4].map((h, i) => ({
      specId: `s${i}`,
      specCreatedAt: at("2026-05-20T00:00:00Z"),
      mergedAt: new Date(at("2026-05-20T00:00:00Z").getTime() + h * 3600_000),
    }));
    const m = deriveDoraMetrics({ ...EMPTY, merges }, OPTIONS);
    expect(m.leadTimeSeconds.value).toBe(2.5 * 3600);
    expect(m.leadTimeSeconds.sample).toBe(4);
  });

  it("picks the middle value for an ODD sample after sorting unordered input", () => {
    // Unsorted 5h,1h,3h -> sorted median 3h. Catches a missing sort or wrong mid.
    const merges = [5, 1, 3].map((h, i) => ({
      specId: `s${i}`,
      specCreatedAt: at("2026-05-20T00:00:00Z"),
      mergedAt: new Date(at("2026-05-20T00:00:00Z").getTime() + h * 3600_000),
    }));
    const m = deriveDoraMetrics({ ...EMPTY, merges }, OPTIONS);
    expect(m.leadTimeSeconds.value).toBe(3 * 3600);
  });

  it("drops negative lead-time gaps but keeps the clean count (the s >= 0 filter)", () => {
    const merges = [
      { specId: "neg", specCreatedAt: at("2026-05-20T05:00:00Z"), mergedAt: at("2026-05-20T01:00:00Z") },
      { specId: "ok", specCreatedAt: at("2026-05-21T00:00:00Z"), mergedAt: at("2026-05-21T02:00:00Z") },
    ];
    const m = deriveDoraMetrics({ ...EMPTY, merges }, OPTIONS);
    expect(m.leadTimeSeconds.value).toBe(2 * 3600);
    expect(m.leadTimeSeconds.sample).toBe(1);
  });
});

describe("deriveDoraMetrics — deploy frequency divisor", () => {
  it("divides merge count by windowDays (not a constant)", () => {
    const merges = Array.from({ length: 9 }, (_, i) => ({
      specId: `s${i}`,
      specCreatedAt: at("2026-05-10T00:00:00Z"),
      mergedAt: at("2026-05-10T01:00:00Z"),
    }));
    // 9 merges / 30 days = 0.3.
    const m = deriveDoraMetrics({ ...EMPTY, merges }, { ...OPTIONS, windowDays: 30 });
    expect(m.deployFrequencyPerDay.value).toBeCloseTo(0.3, 9);
    // Same merges over a 9-day window -> exactly 1.0, proving the divisor is read.
    const m9 = deriveDoraMetrics({ ...EMPTY, merges }, { ...OPTIONS, windowDays: 9 });
    expect(m9.deployFrequencyPerDay.value).toBe(1);
  });
});

describe("deriveDoraMetrics — change-failure boundary statuses", () => {
  it("counts failed/halted/cancelled as failures and done/completed as clean", () => {
    const finishedRuns = [
      { runId: "r1", status: "done", endedAt: WINDOW_END },
      { runId: "r2", status: "completed", endedAt: WINDOW_END },
      { runId: "r3", status: "failed", endedAt: WINDOW_END },
      { runId: "r4", status: "halted", endedAt: WINDOW_END },
      { runId: "r5", status: "cancelled", endedAt: WINDOW_END },
    ];
    const m = deriveDoraMetrics({ ...EMPTY, finishedRuns }, OPTIONS);
    // 3 failures / 5 = 0.6.
    expect(m.changeFailureRate.value).toBeCloseTo(0.6, 9);
    expect(m.totals.failedRuns).toBe(3);
    expect(m.changeFailureRate.sample).toBe(5);
  });

  it("treats an unknown terminal status as NOT a failure", () => {
    // A status outside the FAILURE_STATUSES set must not inflate failures.
    const finishedRuns = [
      { runId: "r1", status: "done", endedAt: WINDOW_END },
      { runId: "r2", status: "mysterious", endedAt: WINDOW_END },
    ];
    const m = deriveDoraMetrics({ ...EMPTY, finishedRuns }, OPTIONS);
    expect(m.changeFailureRate.value).toBe(0);
    expect(m.totals.failedRuns).toBe(0);
  });
});

describe("deriveDoraMetrics — totals + null absence", () => {
  it("reports null (not zero) for every uncomputable metric on empty input", () => {
    const m = deriveDoraMetrics(EMPTY, OPTIONS);
    expect(m.leadTimeSeconds.value).toBeNull();
    expect(m.deployFrequencyPerDay.value).toBeNull();
    expect(m.changeFailureRate.value).toBeNull();
    expect(m.meanTimeToRestoreSeconds.value).toBeNull();
    expect(m.totals).toEqual({ merges: 0, finishedRuns: 0, failedRuns: 0, recoveries: 0 });
  });

  it("MTTR counts only recovered halts and medians their restore gaps", () => {
    const recoveries = [
      { specId: "s1", haltedAt: at("2026-05-15T00:00:00Z"), recoveredAt: at("2026-05-15T01:00:00Z") },
      { specId: "s2", haltedAt: at("2026-05-16T00:00:00Z"), recoveredAt: at("2026-05-16T05:00:00Z") },
    ];
    const m = deriveDoraMetrics({ ...EMPTY, recoveries }, OPTIONS);
    // (1h + 5h)/2 = 3h.
    expect(m.meanTimeToRestoreSeconds.value).toBe(3 * 3600);
    expect(m.totals.recoveries).toBe(2);
  });
});

// Recording fake pool for the loader. Captures the three query shapes and
// returns scripted rows so the window math + row mapping run for real.
class DoraLoaderPool {
  readonly sinceParams: Date[] = [];
  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const t = sql.trim();
    if (t.includes("merge.completed") && t.includes("spec_created_at")) {
      this.sinceParams.push(params[1] as Date);
      return {
        rows: [
          {
            spec_id: "s1",
            spec_created_at: new Date("2026-05-20T00:00:00Z"),
            merged_at: new Date("2026-05-20T02:00:00Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (t.includes("FROM runs r") && t.includes("'done','completed','failed','halted','cancelled'")) {
      return {
        rows: [
          { run_id: "r1", status: "done", ended_at: new Date("2026-05-21T00:00:00Z") },
          { run_id: "r2", status: "failed", ended_at: new Date("2026-05-21T00:00:00Z") },
        ],
        rowCount: 2,
      };
    }
    if (t.includes("halted_at") && t.includes("recovered_at")) {
      return {
        rows: [
          {
            spec_id: "s1",
            halted_at: new Date("2026-05-22T00:00:00Z"),
            recovered_at: new Date("2026-05-22T04:00:00Z"),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("computeDoraMetrics — DB loader maps rows and windows", () => {
  it("reduces the loaded rows into the four metrics with a 30-day default window", async () => {
    const pool = new DoraLoaderPool();
    const now = new Date("2026-05-28T00:00:00Z");
    const metrics = await computeDoraMetrics(pool as unknown as pg.Pool, { projectId: "project_a", now });
    // 2h lead time, 1 merge / 30 days, 1 failed of 2, 4h restore.
    expect(metrics.leadTimeSeconds.value).toBe(2 * 3600);
    expect(metrics.deployFrequencyPerDay.value).toBeCloseTo(1 / 30, 9);
    expect(metrics.changeFailureRate.value).toBe(0.5);
    expect(metrics.meanTimeToRestoreSeconds.value).toBe(4 * 3600);
    expect(metrics.windowDays).toBe(30);
    // `since` is now - 30d.
    const expectedSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(pool.sinceParams[0]!.getTime()).toBe(expectedSince.getTime());
    expect(metrics.windowStart).toBe(expectedSince.toISOString());
    expect(metrics.windowEnd).toBe(now.toISOString());
  });

  it("honors a custom windowDays in the since computation", async () => {
    const pool = new DoraLoaderPool();
    const now = new Date("2026-05-28T00:00:00Z");
    const metrics = await computeDoraMetrics(pool as unknown as pg.Pool, {
      projectId: "project_a",
      now,
      windowDays: 7,
    });
    expect(metrics.windowDays).toBe(7);
    const expectedSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(pool.sinceParams[0]!.getTime()).toBe(expectedSince.getTime());
    // 1 merge / 7 days.
    expect(metrics.deployFrequencyPerDay.value).toBeCloseTo(1 / 7, 9);
  });
});
