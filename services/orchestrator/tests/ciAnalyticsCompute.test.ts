// Native-gate analytics reducer tests. `deriveCiAnalytics` is pure over its gate
// run observations, so every metric is asserted against hand-built fixtures — no
// DB. Covers pass-rate, per-step pass-rate, slowest/least-reliable steps, retry
// rate, and timing. `reduceGateVerdictsToRuns` is tested for the 1:1 gate.verdict
// mapping (incl. the retry case: two verdicts on one SHA).

import { describe, expect, it } from "vitest";
import {
  deriveCiAnalytics,
  reduceGateVerdictsToRuns,
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
  durationSec = 0,
): CiRunObservation {
  return { headSha, outcome, durationMs: durationSec * 1000, checks };
}

describe("deriveCiAnalytics — run pass-rate + retry rate", () => {
  it("computes run pass-rate over terminal gate runs", () => {
    const a = deriveCiAnalytics(
      { runs: [run("s1", "passed", []), run("s2", "passed", []), run("s3", "failed", [])] },
      OPTIONS,
    );
    expect(a.totalCiRuns).toBe(3);
    expect(a.passedCiRuns).toBe(2);
    expect(a.runPassRate).toBeCloseTo(2 / 3);
  });

  it("retry rate = fraction of SHAs with more than one gate run", () => {
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

describe("deriveCiAnalytics — per-step pass-rate + slowest", () => {
  it("computes per-step pass-rate and orders least-reliable first", () => {
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
  it("computes median + max seconds from each gate run's own duration", () => {
    const a = deriveCiAnalytics(
      { runs: [run("s1", "passed", [], 60), run("s2", "passed", [], 120), run("s3", "passed", [], 30)] },
      OPTIONS,
    );
    expect(a.timing.medianSeconds).toBe(60);
    expect(a.timing.maxSeconds).toBe(120);
    expect(a.timing.sample).toBe(3);
  });
});

function verdict(
  headSha: string,
  passed: boolean,
  tsMs: number,
  steps: Array<{ name: string; tier: string; passed: boolean }> = [],
  durationMs = 0,
) {
  return { payload: { headSha, passed, durationMs, steps }, ts: new Date(tsMs) };
}

describe("reduceGateVerdictsToRuns — 1:1 verdict mapping", () => {
  it("maps a passing verdict to one run with per-step checks", () => {
    const runs = reduceGateVerdictsToRuns([
      verdict("s1", true, 5000, [{ name: "unit", tier: "fast", passed: true }], 5000),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("passed");
    expect(runs[0]!.durationMs).toBe(5000);
    expect(runs[0]!.checks).toEqual([{ name: "unit", outcome: "passed" }]);
  });

  it("models a retry: two verdicts on one SHA", () => {
    const runs = reduceGateVerdictsToRuns([verdict("s1", false, 1000), verdict("s1", true, 3000)]);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.outcome)).toEqual(["failed", "passed"]);
  });

  it("maps a failed step to a failed outcome", () => {
    const runs = reduceGateVerdictsToRuns([
      verdict("s1", false, 1000, [{ name: "unit", tier: "fast", passed: false }]),
    ]);
    expect(runs[0]!.checks).toEqual([{ name: "unit", outcome: "failed" }]);
  });
});
