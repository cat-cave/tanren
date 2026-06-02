// P2e-1 CI-analytics reducer tests. `deriveCiAnalytics` is pure over its CI run
// observations, so every metric is asserted against hand-built fixtures — no
// DB. Covers pass-rate, per-check pass-rate, slowest/least-reliable checks,
// retry rate, and timing. `reduceCiEventsToRuns` is tested for the
// started→terminal pairing (incl. the retry case: two runs on one SHA).

import { describe, expect, it } from "vitest";
import {
  deriveCiAnalytics,
  reduceCiEventsToRuns,
  type CiRunObservation,
  type DeriveCiOptions,
} from "../src/engine/insights/ci/index.js";

const WINDOW_END = new Date("2026-05-28T00:00:00.000Z");
const WINDOW_DAYS = 30;
const WINDOW_START = new Date(WINDOW_END.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
const OPTIONS: DeriveCiOptions = {
  projectId: "project_a",
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  windowDays: WINDOW_DAYS,
};

function run(
  headSha: string,
  outcome: "passed" | "failed",
  checks: Array<{ name: string; outcome: "passed" | "failed" }>,
  durationSec: number | null = null,
): CiRunObservation {
  const endedAt = new Date("2026-05-20T00:00:00Z");
  const startedAt = durationSec === null ? null : new Date(endedAt.getTime() - durationSec * 1000);
  return { headSha, outcome, startedAt, endedAt, checks };
}

describe("deriveCiAnalytics — run pass-rate + retry rate", () => {
  it("computes run pass-rate over terminal CI runs", () => {
    const a = deriveCiAnalytics(
      { runs: [run("s1", "passed", []), run("s2", "passed", []), run("s3", "failed", [])] },
      OPTIONS,
    );
    expect(a.totalCiRuns).toBe(3);
    expect(a.passedCiRuns).toBe(2);
    expect(a.runPassRate).toBeCloseTo(2 / 3);
  });

  it("retry rate = fraction of SHAs with more than one CI run", () => {
    const a = deriveCiAnalytics(
      { runs: [run("s1", "failed", []), run("s1", "passed", []), run("s2", "passed", [])] },
      OPTIONS,
    );
    // 2 distinct SHAs, s1 retried → 1/2.
    expect(a.retryRate).toBeCloseTo(0.5);
  });

  it("returns null pass-rate / retry-rate on an empty window", () => {
    const a = deriveCiAnalytics({ runs: [] }, OPTIONS);
    expect(a.runPassRate).toBeNull();
    expect(a.retryRate).toBeNull();
    expect(a.timing.medianSeconds).toBeNull();
  });
});

describe("deriveCiAnalytics — per-check pass-rate + slowest", () => {
  it("computes per-check pass-rate and orders least-reliable first", () => {
    const a = deriveCiAnalytics(
      {
        runs: [
          run("s1", "failed", [
            { name: "unit", outcome: "passed" },
            { name: "e2e", outcome: "failed" },
          ]),
          run("s2", "passed", [
            { name: "unit", outcome: "passed" },
            { name: "e2e", outcome: "passed" },
          ]),
        ],
      },
      OPTIONS,
    );
    const unit = a.checks.find((c) => c.checkName === "unit")!;
    const e2e = a.checks.find((c) => c.checkName === "e2e")!;
    expect(unit.passRate).toBe(1);
    expect(e2e.passRate).toBe(0.5);
    // least-reliable first
    expect(a.checks[0]!.checkName).toBe("e2e");
    // slowest = those with fail-rate > 0
    expect(a.slowestChecks.map((c) => c.checkName)).toEqual(["e2e"]);
  });
});

describe("deriveCiAnalytics — timing", () => {
  it("computes median + max wall-clock seconds where a start was observed", () => {
    const a = deriveCiAnalytics(
      { runs: [run("s1", "passed", [], 60), run("s2", "passed", [], 120), run("s3", "passed", [], 30)] },
      OPTIONS,
    );
    expect(a.timing.medianSeconds).toBe(60);
    expect(a.timing.maxSeconds).toBe(120);
    expect(a.timing.sample).toBe(3);
  });
});

function ev(type: string, headSha: string, tsMs: number, checkRuns: unknown[] = []) {
  return { event_type: type, payload: { headSha, checkRuns }, ts: new Date(tsMs) };
}

describe("reduceCiEventsToRuns — started→terminal pairing", () => {
  it("pairs each terminal with the earliest unpaired start on the same SHA", () => {
    const runs = reduceCiEventsToRuns([
      ev("ci.started", "s1", 0),
      ev("ci.passed", "s1", 5000, [{ name: "unit", conclusion: "success" }]),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("passed");
    expect(runs[0]!.startedAt).not.toBeNull();
    expect(runs[0]!.checks).toEqual([{ name: "unit", outcome: "passed" }]);
  });

  it("models a retry: two started→terminal pairs on one SHA", () => {
    const runs = reduceCiEventsToRuns([
      ev("ci.started", "s1", 0),
      ev("ci.failed", "s1", 1000),
      ev("ci.started", "s1", 2000),
      ev("ci.passed", "s1", 3000),
    ]);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.outcome)).toEqual(["failed", "passed"]);
    expect(runs.every((r) => r.startedAt !== null)).toBe(true);
  });

  it("drops pending check runs (null conclusion) from the per-check signal", () => {
    const runs = reduceCiEventsToRuns([
      ev("ci.failed", "s1", 1000, [
        { name: "unit", conclusion: "failure" },
        { name: "slow", conclusion: null },
      ]),
    ]);
    expect(runs[0]!.checks).toEqual([{ name: "unit", outcome: "failed" }]);
  });
});
