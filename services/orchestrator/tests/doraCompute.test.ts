// P3-0019 DORA-metric reducer tests. `deriveDoraMetrics` is pure over its
// inputs (merge / finished-run / recovery rows), so every metric is asserted
// against hand-built fixture rows — no DB. Covers each of the four metrics plus
// the honest-absence (`null`) and genuine-zero shapes.

import { describe, expect, it } from "vitest";
import { deriveDoraMetrics, type DoraInputs, type DeriveOptions } from "../src/engine/insights/dora/index.js";

const WINDOW_END = new Date("2026-05-28T00:00:00.000Z");
const WINDOW_DAYS = 30;
const WINDOW_START = new Date(WINDOW_END.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

const OPTIONS: DeriveOptions = {
  projectId: "project_a",
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  windowDays: WINDOW_DAYS,
};

/** ISO offset helper: `hoursBefore(WINDOW_END, 21)` etc. */
function at(iso: string): Date {
  return new Date(iso);
}

const EMPTY: DoraInputs = { merges: [], finishedRuns: [], recoveries: [] };

describe("deriveDoraMetrics — lead time", () => {
  it("is the median spec→merge gap in seconds", () => {
    const inputs: DoraInputs = {
      ...EMPTY,
      merges: [
        // 1h, 3h, 5h lead times → median 3h = 10800s.
        {
          specId: "s1",
          specCreatedAt: at("2026-05-20T00:00:00Z"),
          mergedAt: at("2026-05-20T01:00:00Z"),
        },
        {
          specId: "s2",
          specCreatedAt: at("2026-05-21T00:00:00Z"),
          mergedAt: at("2026-05-21T03:00:00Z"),
        },
        {
          specId: "s3",
          specCreatedAt: at("2026-05-22T00:00:00Z"),
          mergedAt: at("2026-05-22T05:00:00Z"),
        },
      ],
    };
    const m = deriveDoraMetrics(inputs, OPTIONS);
    expect(m.leadTimeSeconds.value).toBe(3 * 3600);
    expect(m.leadTimeSeconds.sample).toBe(3);
  });

  it("ignores impossible (negative) lead times but counts the clean ones", () => {
    const inputs: DoraInputs = {
      ...EMPTY,
      merges: [
        {
          specId: "s1",
          specCreatedAt: at("2026-05-20T02:00:00Z"),
          mergedAt: at("2026-05-20T01:00:00Z"),
        }, // negative
        {
          specId: "s2",
          specCreatedAt: at("2026-05-21T00:00:00Z"),
          mergedAt: at("2026-05-21T02:00:00Z"),
        }, // 2h
      ],
    };
    const m = deriveDoraMetrics(inputs, OPTIONS);
    expect(m.leadTimeSeconds.value).toBe(2 * 3600);
    expect(m.leadTimeSeconds.sample).toBe(1);
  });

  it("reports null (not zero) when nothing has merged", () => {
    const m = deriveDoraMetrics(EMPTY, OPTIONS);
    expect(m.leadTimeSeconds.value).toBeNull();
    expect(m.leadTimeSeconds.sample).toBe(0);
  });
});

describe("deriveDoraMetrics — deploy frequency", () => {
  it("is merges divided by the window length in days", () => {
    const merges = Array.from({ length: 6 }, (_, i) => ({
      specId: `s${i}`,
      specCreatedAt: at("2026-05-10T00:00:00Z"),
      mergedAt: at("2026-05-10T01:00:00Z"),
    }));
    const m = deriveDoraMetrics({ ...EMPTY, merges }, OPTIONS);
    expect(m.deployFrequencyPerDay.value).toBeCloseTo(6 / 30, 6);
    expect(m.deployFrequencyPerDay.sample).toBe(6);
  });

  it("is null when there are no merges", () => {
    const m = deriveDoraMetrics(EMPTY, OPTIONS);
    expect(m.deployFrequencyPerDay.value).toBeNull();
  });
});

describe("deriveDoraMetrics — change-failure rate", () => {
  it("is the fraction of finished runs that halted/failed/cancelled", () => {
    const inputs: DoraInputs = {
      ...EMPTY,
      finishedRuns: [
        { runId: "r1", status: "completed", endedAt: WINDOW_END },
        { runId: "r2", status: "done", endedAt: WINDOW_END },
        { runId: "r3", status: "halted", endedAt: WINDOW_END },
        { runId: "r4", status: "failed", endedAt: WINDOW_END },
      ],
    };
    const m = deriveDoraMetrics(inputs, OPTIONS);
    expect(m.changeFailureRate.value).toBe(0.5);
    expect(m.changeFailureRate.sample).toBe(4);
    expect(m.totals.failedRuns).toBe(2);
  });

  it("is a genuine numeric zero when every finished run succeeded", () => {
    const inputs: DoraInputs = {
      ...EMPTY,
      finishedRuns: [{ runId: "r1", status: "completed", endedAt: WINDOW_END }],
    };
    const m = deriveDoraMetrics(inputs, OPTIONS);
    expect(m.changeFailureRate.value).toBe(0);
  });

  it("is null when no runs finished", () => {
    const m = deriveDoraMetrics(EMPTY, OPTIONS);
    expect(m.changeFailureRate.value).toBeNull();
  });
});

describe("deriveDoraMetrics — mean time to restore", () => {
  it("is the median halt→recovery gap in seconds", () => {
    const inputs: DoraInputs = {
      ...EMPTY,
      recoveries: [
        // 2h and 4h → median 3h.
        {
          specId: "s1",
          haltedAt: at("2026-05-15T00:00:00Z"),
          recoveredAt: at("2026-05-15T02:00:00Z"),
        },
        {
          specId: "s2",
          haltedAt: at("2026-05-16T00:00:00Z"),
          recoveredAt: at("2026-05-16T04:00:00Z"),
        },
      ],
    };
    const m = deriveDoraMetrics(inputs, OPTIONS);
    expect(m.meanTimeToRestoreSeconds.value).toBe(3 * 3600);
    expect(m.totals.recoveries).toBe(2);
  });

  it("is null when nothing halted-then-recovered", () => {
    const m = deriveDoraMetrics(EMPTY, OPTIONS);
    expect(m.meanTimeToRestoreSeconds.value).toBeNull();
  });
});

describe("deriveDoraMetrics — envelope", () => {
  it("echoes the window + computedAt and is schema-valid", () => {
    const m = deriveDoraMetrics(EMPTY, OPTIONS);
    expect(m.projectId).toBe("project_a");
    expect(m.windowStart).toBe(WINDOW_START.toISOString());
    expect(m.windowEnd).toBe(WINDOW_END.toISOString());
    expect(m.windowDays).toBe(WINDOW_DAYS);
    expect(m.computedAt).toBe(WINDOW_END.toISOString());
    expect(m.totals).toEqual({ merges: 0, finishedRuns: 0, failedRuns: 0, recoveries: 0 });
  });
});
