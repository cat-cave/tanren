import { describe, expect, it } from "vitest";
import {
  computeSelfHealingFunnel,
  type SelfHealingBadges,
  type SelfHealingLoopInput,
} from "../src/engine/governance/selfHealingFunnel.js";
import type { IssueLoopState } from "../src/engine/repositories/issueLoops.js";

function loop(state: IssueLoopState, badges: SelfHealingBadges | null): SelfHealingLoopInput {
  return {
    loopId: `iloop_${state}`,
    projectId: "project_a",
    state,
    severity: "high",
    fingerprint: `fp_${state}`,
    terminal: badges === null ? null : "blocked",
    badges,
  };
}

const GREEN_MERGE_DEPLOY: SelfHealingBadges = {
  gate: "passed",
  merged: "passed",
  deploy: "bound",
  demo: "reachable",
  symptom: "failed",
  source: "absent",
};

const FULL_CLOSE: SelfHealingBadges = {
  gate: "passed",
  merged: "passed",
  deploy: "bound",
  demo: "reachable",
  symptom: "passed",
  source: "verified_closed",
};

describe("computeSelfHealingFunnel", () => {
  it("counts each stage cumulatively as loops that reached at least that stage", () => {
    const funnel = computeSelfHealingFunnel([loop("open", null), loop("reproduced", null), loop("remediating", null)]);
    expect(funnel.totalLoops).toBe(3);
    expect(funnel.counts.opened).toBe(3);
    expect(funnel.counts.reproduced).toBe(2);
    expect(funnel.counts.fixed).toBe(1);
    expect(funnel.counts.merged).toBe(0);
  });

  it("a cosmetic fix reaches deployed via badges but NEVER symptom_verified (the false-green catch)", () => {
    const funnel = computeSelfHealingFunnel([loop("needs_attention", GREEN_MERGE_DEPLOY)]);
    expect(funnel.counts.merged).toBe(1);
    expect(funnel.counts.deployed).toBe(1);
    // symptom badge is failed → the loop must not cross the symptom stage.
    expect(funnel.counts.symptom_verified).toBe(0);
    expect(funnel.counts.source_closed).toBe(0);
    expect(funnel.loops[0]?.furthestStage).toBe("deployed");
  });

  it("a real verified close reaches every stage through source_closed", () => {
    const funnel = computeSelfHealingFunnel([loop("verified_closed", FULL_CLOSE)]);
    expect(funnel.counts.symptom_verified).toBe(1);
    expect(funnel.counts.source_closed).toBe(1);
    expect(funnel.loops[0]?.furthestStage).toBe("source_closed");
  });

  it("in-flight verifying loops reach deployed from state alone (no sealed proof yet)", () => {
    const funnel = computeSelfHealingFunnel([loop("verifying", null)]);
    expect(funnel.counts.deployed).toBe(1);
    expect(funnel.counts.symptom_verified).toBe(0);
    expect(funnel.loops[0]?.hasProof).toBe(false);
  });
});
