// The WRITER STEERING for a confirmed test regression. This is where the whole contract
// cashes out: the gate's verdict becomes text the writer reads inside the same loop
// iteration that broke the tests, via `gateReason` → the writer rework prompt.
import { describe, expect, it } from "vitest";
import { gateReason, testRegressionDirective } from "../src/engine/workflow/subtaskInnerLoop.js";

function regressionFailure(overrides: Record<string, unknown> = {}) {
  return {
    tier: "fast",
    when: "per_iteration" as const,
    failedStep: "test-backend",
    exitCode: 1,
    failedReason: "test_regression" as const,
    regression: {
      regressed: ["pkg.test_handlers_emr_push.test_guard", "pkg.test_handlers_flow.test_lifecycle"],
      regressedCount: 2,
      unconfirmedCount: 0,
      baselineTotal: 12188,
      observedTotal: 12189,
    },
    steps: [],
    ...overrides,
  };
}

describe("testRegressionDirective", () => {
  it("names the regressed tests and the baseline scale", () => {
    const text = testRegressionDirective(regressionFailure() as never);
    expect(text).toBeDefined();
    expect(text).toContain("pkg.test_handlers_emr_push.test_guard");
    expect(text).toContain("pkg.test_handlers_flow.test_lifecycle");
    expect(text).toContain("12188");
  });

  it("returns undefined for the exit_code class", () => {
    const failure = { tier: "fast", when: "per_iteration" as const, failedStep: "lint", exitCode: 1, steps: [] };
    expect(testRegressionDirective(failure as never)).toBeUndefined();
  });

  it("returns undefined for the evidence_insufficient class", () => {
    const failure = regressionFailure({ failedReason: "evidence_insufficient" });
    expect(testRegressionDirective(failure as never)).toBeUndefined();
  });

  it("returns undefined when the verdict is missing entirely", () => {
    const failure = regressionFailure({ regression: undefined });
    expect(testRegressionDirective(failure as never)).toBeUndefined();
  });

  it("returns undefined when the confirmed count is zero (a step that did not actually fail here)", () => {
    const failure = regressionFailure({
      regression: { regressed: [], regressedCount: 0, unconfirmedCount: 3, baselineTotal: 10, observedTotal: 10 },
    });
    expect(testRegressionDirective(failure as never)).toBeUndefined();
  });
});

describe("gateReason carries the regression directive to the writer", () => {
  it("includes the regression block alongside the tier/step header", () => {
    const reason = gateReason({ passed: false, results: [], failure: regressionFailure() } as never);
    expect(reason).toContain('gate tier "fast" (per_iteration) failed at step "test-backend"');
    expect(reason).toContain("TEST REGRESSION [gate-test-regression]");
    expect(reason).toContain("pkg.test_handlers_emr_push.test_guard");
  });

  it("still renders the plain header for a non-regression failure", () => {
    const failure = { tier: "fast", when: "per_iteration" as const, failedStep: "lint", exitCode: 1, steps: [] };
    const reason = gateReason({ passed: false, results: [], failure } as never);
    expect(reason).not.toContain("TEST REGRESSION");
    expect(reason).toContain('failed at step "lint"');
  });
});
