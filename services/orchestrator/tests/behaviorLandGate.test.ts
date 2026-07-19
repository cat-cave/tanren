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
    countInconsistent: false,
    ...overrides,
  };
}

describe("evaluateBehaviorLandGate — required-vs-not-applicable predicate", () => {
  it("no pre-merge verification run (undefined status) → not_applicable (never blocks a non-behavior run)", () => {
    expect(evaluateBehaviorLandGate(undefined, [])).toEqual({ kind: "not_applicable" });
  });

  // The ONLY not_applicable is a run that never existed. A pre-merge run that reached a terminal
  // state without a decisive blocking pass MUST fail closed — never fall through to a merge.

  it("(fix #1) completed run with NO verdicts at all → inconclusive (absent-when-required, fail closed)", () => {
    // Previously returned not_applicable — the exact absent-when-required fail-open the audit
    // flagged. A completed pre-merge run IS the requirement; empty is not a green.
    expect(evaluateBehaviorLandGate("completed", []).kind).toBe("inconclusive");
  });

  it("(fix #1) completed run with ONLY advisory verdicts → inconclusive (no blocking pass; fail closed)", () => {
    const gate = evaluateBehaviorLandGate("completed", [verdict({ gateEffect: "advisory", outcome: "passed" })]);
    expect(gate.kind).toBe("inconclusive");
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

describe("evaluateBehaviorLandGate — count-inconsistent evidence poisons the whole run (fail closed)", () => {
  it("a count-inconsistent FAILING verdict alongside a count-consistent PASSING sibling → inconclusive (never silently dropped)", () => {
    // THE fail-open this closes: a fabricated-count blocking FAILURE must NOT be excluded so a
    // count-consistent passing sibling can authorize. Any count-inconsistent verdict on the run
    // poisons the gate → inconclusive (→ blocked), mirroring the sibling readers that throw.
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-pass", outcome: "passed", countInconsistent: false }),
      verdict({ behaviorRevisionId: "br-fabricated", outcome: "failed_product", countInconsistent: true }),
    ]);
    expect(gate.kind).toBe("inconclusive");
  });

  it("a single count-inconsistent verdict (even if it self-reports 'passed') → inconclusive (unverifiable evidence)", () => {
    const gate = evaluateBehaviorLandGate("completed", [verdict({ outcome: "passed", countInconsistent: true })]);
    expect(gate.kind).toBe("inconclusive");
  });

  it("count-inconsistency outranks even a decisive failure classification → inconclusive (evidence untrustworthy)", () => {
    // Once evidence is unverifiable we cannot even trust the 'failed' label — the run is inconclusive.
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-bad", outcome: "failed_product", countInconsistent: true }),
    ]);
    expect(gate.kind).toBe("inconclusive");
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

describe("evaluateBehaviorLandGate — quarantine excludes only NON-failure noise (fix #3)", () => {
  it("a quarantined INCONCLUSIVE is excluded-from-green — a co-passing blocking verdict still passes", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-ok", outcome: "passed" }),
      verdict({
        behaviorRevisionId: "br-flaky",
        outcome: "inconclusive_infrastructure",
        flakeState: "quarantined_fragment",
      }),
    ]);
    // The quarantined inconclusive (flaky infra noise) is excluded; the remaining blocking
    // behavior passed, so the gate passes. This is the ONLY legitimate quarantine exclusion.
    expect(gate).toEqual({ kind: "passed", passedBlockingCount: 1 });
  });

  it("(fix #3) a quarantined failed_product STILL blocks — a self-asserted quarantine bit never launders a failure", () => {
    // A decisive product failure blocks regardless of flake_state: without rv-17 governance, a
    // verdict row cannot exempt its own genuine failure by self-asserting quarantine.
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ behaviorRevisionId: "br-ok", outcome: "passed" }),
      verdict({ behaviorRevisionId: "br-flaky", outcome: "failed_product", flakeState: "quarantined_fragment" }),
    ]);
    expect(gate).toMatchObject({ kind: "failed", outcome: "failed_product" });
  });

  it("(fix #3) the ONLY blocking verdict being a quarantined failed_visual → failed (never laundered)", () => {
    const gate = evaluateBehaviorLandGate("completed", [
      verdict({ outcome: "failed_visual", flakeState: "quarantined_fragment" }),
    ]);
    expect(gate).toMatchObject({ kind: "failed", outcome: "failed_visual" });
  });
});
