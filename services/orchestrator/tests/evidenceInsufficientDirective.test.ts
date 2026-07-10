import { describe, expect, it } from "vitest";
import { evidenceInsufficientDirective } from "../src/engine/workflow/subtaskInnerLoop.js";

function evidenceFailureWith(reason: string, observed: Record<string, unknown>, required: Record<string, unknown>) {
  return {
    tier: "slow",
    when: "pre_audit" as const,
    failedStep: "test",
    exitCode: 0,
    failedReason: "evidence_insufficient" as const,
    evidence: {
      kind: "junit" as const,
      sufficient: false as const,
      reason: reason as "junit_zero_tests",
      observed,
      required,
    },
    steps: [],
  };
}

describe("evidenceInsufficientDirective — the writer-rework directive names the class precisely (task #64)", () => {
  it("returns undefined when the failure is the historical exit_code class (no evidence verdict)", () => {
    const failure = { tier: "fast", when: "per_iteration" as const, failedStep: "lint", exitCode: 1, steps: [] };
    expect(evidenceInsufficientDirective(failure as never)).toBeUndefined();
  });

  it("names the class as `gate-evidence-insufficient-junit_zero_tests` for the zero-tests case", () => {
    const directive = evidenceInsufficientDirective(
      evidenceFailureWith("junit_zero_tests", { total: 0 }, { minTests: 1 }) as never,
    );
    expect(directive).toBeDefined();
    expect(directive).toContain("gate-evidence-insufficient-junit_zero_tests");
    expect(directive).toContain("required 1");
  });

  it("names the class as `gate-evidence-insufficient-junit_below_threshold` and surfaces observed-vs-required counts", () => {
    const directive = evidenceInsufficientDirective(
      evidenceFailureWith("junit_below_threshold", { total: 2 }, { minTests: 10 }) as never,
    );
    expect(directive).toContain("gate-evidence-insufficient-junit_below_threshold");
    expect(directive).toContain("2 of 10");
  });

  it("names the class as `gate-evidence-insufficient-junit_missing` and surfaces the declared path", () => {
    const directive = evidenceInsufficientDirective(
      evidenceFailureWith(
        "junit_missing",
        { reportPath: "out/r.xml", readReason: "absent" },
        { reportPath: "out/r.xml", minTests: 1 },
      ) as never,
    );
    expect(directive).toContain("gate-evidence-insufficient-junit_missing");
    expect(directive).toContain("out/r.xml");
  });
});
