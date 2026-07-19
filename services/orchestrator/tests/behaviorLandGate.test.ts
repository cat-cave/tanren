// rv-gate — the DB-free decision table for `evaluateBehaviorLandGate`: which runtime
// behavior outcomes gate a land, and (critically) which do NOT. The REAL production land
// consumption is proven in mergeAuthorityGate.test.ts (driving `authorizeAndLand`); this
// pins the fail-closed classification the reader feeds it.

import { describe, expect, it } from "vitest";
import { evaluateBehaviorLandGate, type BehaviorVerdictRow } from "../src/engine/merge/behaviorLandGate.js";

function verdict(overrides: Partial<BehaviorVerdictRow> = {}): BehaviorVerdictRow {
  return {
    behaviorRevisionId: "br-1",
    outcome: "passed",
    flakeState: "stable",
    gateEffect: "blocking",
    ...overrides,
  };
}

describe("evaluateBehaviorLandGate — required-vs-not-applicable predicate", () => {
  it("no pre-merge verification run (undefined status) → not_applicable (never blocks)", () => {
    expect(evaluateBehaviorLandGate(undefined, [])).toEqual({ kind: "not_applicable" });
  });

  it("a completed run with only ADVISORY verdicts → not_applicable (advisory never gates)", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ gateEffect: "advisory", outcome: "failed_product" }),
    ]);
    expect(gate.kind).toBe("not_applicable");
  });

  it("a completed run with NO verdicts at all → not_applicable (nothing to enforce)", () => {
    expect(evaluateBehaviorLandGate("completed", [])).toEqual({ kind: "not_applicable" });
  });
});

describe("evaluateBehaviorLandGate — fail-closed when behavior WAS required", () => {
  it("a still-running verification run → inconclusive (required-but-not-decided, fail closed)", () => {
    const gate = evaluateBehaviorLandGate("running", []);
    expect(gate).toMatchObject({ kind: "inconclusive" });
  });

  it("a failed/cancelled verification run → inconclusive (fail closed)", () => {
    expect(evaluateBehaviorLandGate("failed", []).kind).toBe("inconclusive");
    expect(evaluateBehaviorLandGate("cancelled", []).kind).toBe("inconclusive");
  });

  it("a blocking failed_product verdict → failed (decisive product failure)", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ outcome: "passed" }),
      verdict({ behaviorRevisionId: "br-2", outcome: "failed_product" }),
    ]);
    expect(gate).toEqual({ kind: "failed", behaviorRevisionId: "br-2", outcome: "failed_product" });
  });

  it("a blocking failed_visual / failed_verification_contract verdict → failed", () => {
    expect(evaluateBehaviorLandGate("completed", [verdict({ outcome: "failed_visual" })]).kind).toBe("failed");
    expect(evaluateBehaviorLandGate("completed", [verdict({ outcome: "failed_verification_contract" })]).kind).toBe(
      "failed",
    );
  });

  it("a blocking inconclusive_* verdict → inconclusive (inconclusive ≠ passed)", () => {
    expect(evaluateBehaviorLandGate("completed", [verdict({ outcome: "inconclusive_infrastructure" })]).kind).toBe(
      "inconclusive",
    );
    expect(evaluateBehaviorLandGate("completed", [verdict({ outcome: "inconclusive_external" })]).kind).toBe(
      "inconclusive",
    );
  });

  it("a decisive product failure OUTRANKS a co-occurring inconclusive (most actionable first)", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-inc", outcome: "inconclusive_external" }),
      verdict({ behaviorRevisionId: "br-fail", outcome: "failed_product" }),
    ]);
    expect(gate).toEqual({ kind: "failed", behaviorRevisionId: "br-fail", outcome: "failed_product" });
  });
});

describe("evaluateBehaviorLandGate — only an actual pass clears", () => {
  it("every blocking non-quarantined verdict passed → passed", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-1" }),
      verdict({ behaviorRevisionId: "br-2" }),
    ]);
    expect(gate).toEqual({ kind: "passed", passedBlockingCount: 2 });
  });
});

describe("evaluateBehaviorLandGate — quarantine is excluded-from-green (rv-17 semantics)", () => {
  it("a quarantined FAILING verdict does NOT block (flake noise excluded), leaving a passing gate", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-ok", outcome: "passed" }),
      verdict({ behaviorRevisionId: "br-flaky", outcome: "failed_product", flakeState: "quarantined_fragment" }),
    ]);
    // The quarantined failure is neither counted toward green nor used to block: the
    // remaining blocking behavior passed, so the gate passes.
    expect(gate).toEqual({ kind: "passed", passedBlockingCount: 1 });
  });

  it("when the ONLY blocking verdict is quarantined → not_applicable (nothing left to enforce)", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ outcome: "failed_product", flakeState: "quarantined_fragment" }),
    ]);
    expect(gate.kind).toBe("not_applicable");
  });
});
