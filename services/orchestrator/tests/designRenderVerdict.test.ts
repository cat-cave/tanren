// ds-4 sub-node #3 — the FAIL-CLOSED run-level aggregation of per-scenario design-render
// checkpoints. No render, no DB: pins the decision table (any failure blocks; a clean pass
// clears; nothing-verifiable is inconclusive, never a silent pass).

import { describe, expect, it } from "vitest";
import {
  aggregateDesignRenderOutcome,
  checkpointVerdictFromOracle,
  notApplicableDesignRenderVerification,
  type DesignRenderCheckpoint,
} from "../src/engine/design/render/designRenderVerdict.js";

const passed = (id: string): DesignRenderCheckpoint => ({ checkpointId: id, verdict: "passed", failingRuleIds: [] });
const failed = (id: string, ruleIds: string[]): DesignRenderCheckpoint => ({
  checkpointId: id,
  verdict: "failed",
  failingRuleIds: ruleIds,
});
const unknown = (id: string): DesignRenderCheckpoint => ({ checkpointId: id, verdict: "unknown", failingRuleIds: [] });

describe("aggregateDesignRenderOutcome — fail-closed run-level design-render outcome", () => {
  it("ANY failed checkpoint → failed_visual, carrying the first failing scenario + rule ids", () => {
    const result = aggregateDesignRenderOutcome(
      "wcag-2.2-aa",
      [passed("a"), failed("b", ["image-alt"]), passed("c")],
      0,
    );
    expect(result.outcome).toBe("failed_visual");
    expect(result.failingScenarioKey).toBe("b");
    expect(result.failingRuleIds).toEqual(["image-alt"]);
    expect(result.failedCount).toBe(1);
    expect(result.passedCount).toBe(2);
  });

  it("no failure + at least one passed → passed (an inconclusive sibling does NOT block)", () => {
    const result = aggregateDesignRenderOutcome("wcag-2.2-aa", [passed("a"), unknown("b")], 0);
    expect(result.outcome).toBe("passed");
    expect(result.passedCount).toBe(1);
    expect(result.inconclusiveCount).toBe(1);
    expect(result.failingScenarioKey).toBeNull();
  });

  it("nothing verifiable (all unknown) → inconclusive_infrastructure (never a silent pass)", () => {
    const result = aggregateDesignRenderOutcome("wcag-2.2-aa", [unknown("a"), unknown("b")], 0);
    expect(result.outcome).toBe("inconclusive_infrastructure");
  });

  it("every scenario excluded (nothing rendered browser-free) → inconclusive_infrastructure", () => {
    const result = aggregateDesignRenderOutcome("wcag-2.2-aa", [], 4);
    expect(result.outcome).toBe("inconclusive_infrastructure");
    expect(result.excludedCount).toBe(4);
  });

  it("a failure wins even alongside a pass (fail-closed)", () => {
    expect(aggregateDesignRenderOutcome("wcag-2.2-aa", [passed("a"), failed("b", [])], 0).outcome).toBe(
      "failed_visual",
    );
  });
});

describe("checkpointVerdictFromOracle", () => {
  it("maps oracle outcomes onto checkpoint verdicts (inconclusive → unknown, fail-closed)", () => {
    expect(checkpointVerdictFromOracle("passed")).toBe("passed");
    expect(checkpointVerdictFromOracle("failed_visual")).toBe("failed");
    expect(checkpointVerdictFromOracle("inconclusive_infrastructure")).toBe("unknown");
  });
});

describe("notApplicableDesignRenderVerification", () => {
  it("is an empty, non-blocking verification (advisory posture)", () => {
    const result = notApplicableDesignRenderVerification("none");
    expect(result.outcome).toBe("not_applicable");
    expect(result.checkpoints).toHaveLength(0);
  });
});
