// rv-21 Gap 4 — DB-free unit coverage for the PRODUCTION post-synthesis coverage
// assertion (`assertContractCoversGraph`). It runs in the derive's graph transaction
// BEFORE the contract row is written, so a proof≠effect divergence fails closed and rolls
// back with no orphan. RLS route tests do not count toward coverage; these cases pin the
// exact-multiset checks + both fail-closed arms.

import { describe, expect, it } from "vitest";
import {
  DESIGN_CONTRACT_VERSION,
  parseDesignContract,
  type DesignContractV1,
} from "../src/engine/design/designContract.js";
import { assertContractCoversGraph, DesignCoverageMismatchError } from "../src/engine/forge/interview/index.js";

function contract(personaRefs: string[], behaviorRefs: string[]): DesignContractV1 {
  return parseDesignContract({
    version: DESIGN_CONTRACT_VERSION,
    domain: "saas-web",
    identity: "an operations surface",
    intent: "calm + dense control surface",
    principles: [],
    constraints: [],
    personaRefs,
    behaviorRefs,
    dimensions: [],
  });
}

describe("assertContractCoversGraph — synthesized coverage must equal the persisted graph", () => {
  it("passes when personaRefs + behaviorRefs are an exact multiset of the persisted ids (order-independent)", () => {
    expect(() =>
      assertContractCoversGraph(
        contract(["persona_b", "persona_a"], ["behavior_2", "behavior_1"]),
        ["persona_a", "persona_b"],
        ["behavior_1", "behavior_2"],
      ),
    ).not.toThrow();
  });

  it("fails closed when a persisted persona is dropped from personaRefs (empty MOAT while entities exist)", () => {
    expect(() => assertContractCoversGraph(contract([], ["behavior_1"]), ["persona_a"], ["behavior_1"])).toThrow(
      DesignCoverageMismatchError,
    );
  });

  it("fails closed when a persisted behavior is dropped from behaviorRefs", () => {
    expect(() =>
      assertContractCoversGraph(contract(["persona_a"], ["behavior_1"]), ["persona_a"], ["behavior_1", "behavior_2"]),
    ).toThrow(DesignCoverageMismatchError);
  });

  it("fails closed on a phantom ref not backed by a persisted entity", () => {
    expect(() =>
      assertContractCoversGraph(
        contract(["persona_a", "persona_phantom"], ["behavior_1"]),
        ["persona_a"],
        ["behavior_1"],
      ),
    ).toThrow(DesignCoverageMismatchError);
  });
});
