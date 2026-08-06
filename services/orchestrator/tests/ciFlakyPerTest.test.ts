// CI-intelligence PR2 tests: the per-TEST flaky reducer + duration profiler (pure
// over hand-built `ci_test_results` observations) AND the merge-gate quarantine
// READ (the actuation fix) — a quarantined check is EXCLUDED from `failingChecks`
// so a proven-flaky failure no longer flips the observation to `failed`, while a
// real (non-quarantined) failure still blocks. The SAFETY invariant is proven:
// a consistently-failing test is NEVER flagged.

import { describe, expect, it } from "vitest";
import {
  deriveFlakyTestsPerTest,
  deriveTestDurationProfiles,
  type CiTestObservation,
} from "../src/engine/insights/ciFlakyTests.js";
import { evaluateCiObservation } from "../src/engine/workflow/ciObservation.js";

const T0 = new Date("2026-05-01T00:00:00Z");
function trow(
  testId: string,
  headSha: string,
  outcome: CiTestObservation["outcome"],
  opts: { durationMs?: number; retries?: number; offsetMs?: number; suite?: string | null } = {},
): CiTestObservation {
  return {
    testId,
    file: null,
    suite: opts.suite ?? null,
    headSha,
    outcome,
    durationMs: opts.durationMs ?? null,
    retries: opts.retries ?? 0,
    observedAt: new Date(T0.getTime() + (opts.offsetMs ?? 0)),
  };
}

describe("deriveFlakyTestsPerTest — cross-run toggle + intra-run recovery", () => {
  it("flags a test that BOTH passed and failed on the same head SHA", () => {
    const verdicts = deriveFlakyTestsPerTest([
      trow("suite.testA", "sha1", "failed", { offsetMs: 0 }),
      trow("suite.testA", "sha1", "passed", { offsetMs: 1000 }),
    ]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.testId).toBe("suite.testA");
    expect(verdicts[0]!.toggledShaCount).toBe(1);
    expect(verdicts[0]!.observationCount).toBe(2);
  });

  it("flags a test that recovered intra-run (retries > 0 with a pass) even without a cross-run toggle", () => {
    const verdicts = deriveFlakyTestsPerTest([trow("suite.flaky", "sha1", "passed", { retries: 2 })]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.intraRunFlakyCount).toBe(1);
    expect(verdicts[0]!.toggledShaCount).toBe(1);
  });

  it("treats an `error` outcome as a failure for the toggle", () => {
    const verdicts = deriveFlakyTestsPerTest([trow("suite.err", "sha1", "error"), trow("suite.err", "sha1", "passed")]);
    expect(verdicts.map((v) => v.testId)).toEqual(["suite.err"]);
  });
});

describe("deriveFlakyTestsPerTest — SAFETY: a consistently-failing test is NEVER flagged", () => {
  it("never flags a test that only ever fails across many SHAs", () => {
    const verdicts = deriveFlakyTestsPerTest([
      trow("suite.broken", "sha1", "failed"),
      trow("suite.broken", "sha2", "failed"),
      trow("suite.broken", "sha3", "failed"),
    ]);
    expect(verdicts).toHaveLength(0);
  });

  it("quarantines ONLY the flaky test next to a broken one", () => {
    const verdicts = deriveFlakyTestsPerTest([
      trow("suite.flaky", "sha1", "failed"),
      trow("suite.flaky", "sha1", "passed"),
      trow("suite.broken", "sha1", "failed"),
      trow("suite.broken", "sha2", "failed"),
    ]);
    expect(verdicts.map((v) => v.testId)).toEqual(["suite.flaky"]);
  });
});

describe("deriveTestDurationProfiles — p50/p95 + slow signal", () => {
  it("computes percentiles and flags a test whose p95 breaches the absolute threshold", () => {
    const rows = [10, 12, 11, 13, 5000].map((d, i) =>
      trow("suite.slow", `sha${i}`, "passed", { durationMs: d, offsetMs: i }),
    );
    const profiles = deriveTestDurationProfiles(rows, { slowP95Ms: 1000, minSamples: 5 });
    const slow = profiles.find((p) => p.testId === "suite.slow");
    expect(slow).toBeDefined();
    expect(slow!.slow).toBe(true);
    expect(slow!.p95Ms).toBeGreaterThan(slow!.p50Ms);
  });

  it("does not flag a fast, stable test", () => {
    const rows = [10, 11, 12, 10, 11].map((d, i) =>
      trow("suite.fast", `sha${i}`, "passed", { durationMs: d, offsetMs: i }),
    );
    const profiles = deriveTestDurationProfiles(rows, { slowP95Ms: 1000, minSamples: 5 });
    expect(profiles.find((p) => p.testId === "suite.fast")!.slow).toBe(false);
  });
});

describe("evaluateCiObservation — THE GATE READ (quarantine exclusion)", () => {
  it("excludes a quarantined failing check so the observation is NOT failed", () => {
    const obs = evaluateCiObservation(
      {
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "flaky-e2e", status: "completed", conclusion: "failure" },
        ],
        statuses: [],
      },
      { quarantinedCheckNames: new Set(["flaky-e2e"]) },
    );
    expect(obs.status).toBe("passed");
    expect(obs.failingChecks).toHaveLength(0);
  });

  it("does NOT mask a non-quarantined (real) failure", () => {
    const obs = evaluateCiObservation(
      {
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        statuses: [],
      },
      { quarantinedCheckNames: new Set(["flaky-e2e"]) },
    );
    expect(obs.status).toBe("failed");
    expect(obs.failingChecks.map((f) => f.name)).toEqual(["build"]);
  });

  it("a quarantined REQUIRED check still fails the run (quarantine cannot satisfy protection)", () => {
    const obs = evaluateCiObservation(
      {
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "flaky-e2e", status: "completed", conclusion: "failure" },
        ],
        statuses: [],
        requiredContexts: ["build", "flaky-e2e"],
      },
      { quarantinedCheckNames: new Set(["flaky-e2e"]) },
    );
    expect(obs.status).toBe("failed");
  });
});
