// The REGRESSION CONTRACT's pure core (engine/ci/regression.ts): the pass→fail
// TRANSITION comparison that lets tests run inside the writer's own loop without
// blocking a writer on the tests it is mid-way through authoring.
//
// These tests pin the DISCRIMINATIONS, not the plumbing. Each one is a case where a
// simpler implementation ("fail if the suite is red", "fail on any failing test", "fail
// on the first red report") gives the wrong answer.
import { describe, expect, it } from "vitest";
import {
  MAX_NAMED_REGRESSIONS,
  baselineFromReport,
  confirmRegressions,
  describeRegressions,
  detectRegressions,
  sampleRegressions,
} from "../src/engine/ci/regression.js";
import type { JunitOutcome, JunitReport, JunitTestResult } from "../src/engine/ci/junit.js";

function testcase(testId: string, outcome: JunitOutcome): JunitTestResult {
  return { testId, file: null, suite: null, outcome, durationMs: null, retries: 0, flakyFailure: false };
}

function report(...cases: JunitTestResult[]): JunitReport {
  return {
    results: cases,
    total: cases.length,
    failures: cases.filter((c) => c.outcome === "failed" || c.outcome === "error").length,
  };
}

describe("baselineFromReport", () => {
  it("keeps only the PASSING tests — a test already red at base has no green state to lose", () => {
    const baseline = baselineFromReport(
      report(
        testcase("a", "passed"),
        testcase("b", "failed"),
        testcase("c", "error"),
        testcase("d", "skipped"),
        testcase("e", "passed"),
      ),
    );
    expect([...baseline.passing].sort()).toEqual(["a", "e"]);
    // The TOTAL is the whole report, not the passing count — it is the scale figure the
    // writer's steering quotes, and conflating the two would understate the suite.
    expect(baseline.total).toBe(5);
  });

  it("excludes skipped tests, so an env-skipped test coming back red is not a regression", () => {
    const baseline = baselineFromReport(report(testcase("skipped-at-base", "skipped")));
    expect(baseline.passing.has("skipped-at-base")).toBe(false);
    expect(detectRegressions(baseline, report(testcase("skipped-at-base", "failed")))).toEqual([]);
  });
});

describe("detectRegressions", () => {
  it("reports a test that was green at base and is now failed", () => {
    const baseline = baselineFromReport(report(testcase("was-green", "passed")));
    expect(detectRegressions(baseline, report(testcase("was-green", "failed")))).toEqual(["was-green"]);
  });

  it("treats an ERROR outcome as a regression, not only a plain failure", () => {
    // An import error / fixture blow-up surfaces as `error`, and it is exactly the shape
    // the motivating bug produced. Counting only `failed` would have missed it.
    const baseline = baselineFromReport(report(testcase("was-green", "passed")));
    expect(detectRegressions(baseline, report(testcase("was-green", "error")))).toEqual(["was-green"]);
  });

  it("does NOT report a failing test that is absent from the baseline — the writer's own new test", () => {
    // THE THRASH CASE, and the reason this contract exists. A writer mid-feature has a
    // legitimately red new test; blocking on it converts the loop into a thrash, which is
    // precisely why every project excluded tests from the per-iteration gate.
    const baseline = baselineFromReport(report(testcase("existing", "passed")));
    const now = report(testcase("existing", "passed"), testcase("brand-new-tdd-test", "failed"));
    expect(detectRegressions(baseline, now)).toEqual([]);
  });

  it("does NOT report a test that was ALREADY failing at base", () => {
    // Measured reality on the repo this was designed against: three pre-existing failures
    // on a clean tree. Judging absolutely would block every writer on breakage it did not
    // cause, on every iteration, forever.
    const baseline = baselineFromReport(report(testcase("already-broken", "failed")));
    expect(detectRegressions(baseline, report(testcase("already-broken", "failed")))).toEqual([]);
  });

  it("does NOT report a baseline-passing test that DISAPPEARED from the report", () => {
    // Deletions and renames are indistinguishable at the id level, and both are ordinary
    // refactors. Firing on disappearance is the false-positive class that gets a gate
    // switched off. Mass disappearance is the `minTests` floor's job at pre_audit/pre_merge.
    const baseline = baselineFromReport(report(testcase("renamed-away", "passed")));
    expect(detectRegressions(baseline, report(testcase("the-new-name", "passed")))).toEqual([]);
  });

  it("does not report a test that is still green", () => {
    const baseline = baselineFromReport(report(testcase("stable", "passed")));
    expect(detectRegressions(baseline, report(testcase("stable", "passed")))).toEqual([]);
  });

  it("returns a sorted, de-duplicated list", () => {
    // Ordering must be TOTAL and deterministic, not merely "a before b": the steering
    // string and the event payload are compared across iterations by the convergence
    // detector, so an unstable order would read as new information every round.
    const ids = ["delta", "alpha", "charlie", "bravo", "echo"];
    const baseline = baselineFromReport(report(...ids.map((id) => testcase(id, "passed"))));
    // A parametrized suite can emit the same id twice; the steering must not repeat it.
    const now = report(
      ...ids.map((id) => testcase(id, "failed")),
      testcase("charlie", "error"),
      testcase("alpha", "failed"),
    );
    expect(detectRegressions(baseline, now)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
  });

  it("returns nothing against an EMPTY report — the zero-test run is vacuously clean", () => {
    // This is what dissolves the `minTests` tension: a regression contract needs no floor,
    // so the per-iteration tier does not manufacture the evidence_insufficient failure.
    const baseline = baselineFromReport(report(testcase("a", "passed")));
    expect(detectRegressions(baseline, report())).toEqual([]);
  });

  it("returns nothing when the baseline is empty — the greenfield scaffold case", () => {
    const baseline = baselineFromReport(report());
    expect(detectRegressions(baseline, report(testcase("new", "failed")))).toEqual([]);
  });
});

describe("confirmRegressions", () => {
  it("keeps only the tests that regressed in BOTH runs", () => {
    // The flake guard. The suite this was designed against measures a ~25% per-run flake
    // rate from a repo-wide 100ms per-test budget; a single red report is not evidence.
    expect(confirmRegressions(["a", "b", "c"], ["b", "c", "d"])).toEqual(["b", "c"]);
  });

  it("clears everything when the second run is clean — a pure flake never reaches the writer", () => {
    expect(confirmRegressions(["flaky"], [])).toEqual([]);
  });

  it("preserves the first run's order and does not invent entries from the second run", () => {
    expect(confirmRegressions(["a"], ["a", "z"])).toEqual(["a"]);
  });

  it("is empty when the first run was clean, whatever the second run says", () => {
    expect(confirmRegressions([], ["a"])).toEqual([]);
  });
});

describe("sampleRegressions", () => {
  it("bounds the reported list", () => {
    const many = Array.from({ length: MAX_NAMED_REGRESSIONS + 10 }, (_, i) => `t${i}`);
    expect(sampleRegressions(many)).toHaveLength(MAX_NAMED_REGRESSIONS);
  });

  it("returns a short list unchanged", () => {
    expect(sampleRegressions(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("describeRegressions", () => {
  it("names the tests, the true count and the baseline scale", () => {
    const text = describeRegressions(["pkg.test_a", "pkg.test_b"], 2, 12188);
    expect(text).toContain("gate-test-regression");
    expect(text).toContain("2 test(s)");
    expect(text).toContain("12188 cases");
    // One test per LINE — a single blob would be unreadable steering.
    expect(text).toContain("  - pkg.test_a\n  - pkg.test_b");
  });

  it("says how many were elided when the count exceeds the named sample", () => {
    const text = describeRegressions(["a"], 40, 100);
    expect(text).toContain("…and 39 more");
  });

  it("does not claim an elision when the sample is complete", () => {
    const text = describeRegressions(["a"], 1, 100);
    expect(text).not.toContain("more");
    // The elision slot must render as EMPTY, not as some other text: the list runs
    // straight into the next sentence.
    expect(text).toContain("  - a\nThe failure reproduced");
  });

  it("tells the writer NOT to rewrite the tests to match its change", () => {
    // The load-bearing sentence. The motivating failure is exactly the case where editing
    // the test looks like a fix: pre-existing tests stub an ordered call sequence, the
    // writer reordered the calls, and "make the test expect the new order" deletes the
    // assertion that caught it. The observed remediation turned 1 failure into 12.
    const text = describeRegressions(["a"], 1, 10);
    expect(text).toContain("Fix the code that broke them.");
    // The WHOLE clause matters: truncating it after "Do NOT edit these tests…" would drop
    // the reason, which is the part that stops the writer rewriting the assertion.
    expect(text).toContain(
      "Do NOT edit these tests to match your new behaviour unless you can state why the OLD assertion " +
        "was wrong — rewriting a test to accept what you just changed deletes the check that caught you.",
    );
  });

  it("states that the failure reproduced, so the writer does not dismiss it as a flake", () => {
    expect(describeRegressions(["a"], 1, 10)).toContain("reproduced across two runs");
  });
});
