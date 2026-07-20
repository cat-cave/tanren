// cspell:ignore premerge mainsha
// ds-6 DB-free contract + fail-closed JOIN proofs. No database: the frozen strict
// DesignDeliveryProofV1 schema and EVERY equivalence branch (including the required
// negative control — a production changed-artifact / changed-scenario that does NOT match
// the pre-merge binding → the join FAILS, never A4 ≡ demo) are asserted here so the
// negative controls count toward the coverage floor; the RLS integration test proves the
// same fail-closed behavior end-to-end on real Postgres.

import { describe, expect, it } from "vitest";
import {
  buildDesignDeliveryProof,
  deriveEquivalence,
  type DesignDeliveryEvidence,
} from "../src/engine/design/queue/designDeliveryProofGates.js";
import {
  DesignDeliveryProofV1,
  parseDesignDeliveryProof,
  type DesignDeliveryPreMergeV1,
  type DesignDeliveryProductionV1,
} from "../src/engine/design/queue/designDeliveryProof.js";

const SHA = (c: string): string => `sha256:${c.repeat(64)}`;

const ARTIFACT = SHA("a");
const CONTRACT = SHA("c");
const NODE = "node-1";

function preMerge(overrides: Partial<DesignDeliveryPreMergeV1> = {}): DesignDeliveryPreMergeV1 {
  return {
    integrationNodeId: NODE,
    proofRoot: SHA("d"),
    releaseId: "rel-1",
    designSystemId: "ds-1",
    contractDigest: CONTRACT,
    designContractVersion: "1",
    renderOutcome: "passed",
    adapterTarget: "web-react",
    artifactDigest: ARTIFACT,
    scenarioKeys: ["button/light/desktop", "card/dark/mobile"],
    cells: [
      {
        scenarioKey: "button/light/desktop",
        renderVerdict: "passed",
        designProofKey: SHA("1"),
        proofUnitId: "pu-1",
        reused: false,
      },
      {
        scenarioKey: "card/dark/mobile",
        renderVerdict: "passed",
        designProofKey: SHA("2"),
        proofUnitId: "pu-2",
        reused: false,
      },
    ],
    ...overrides,
  };
}

function production(overrides: Partial<DesignDeliveryProductionV1> = {}): DesignDeliveryProductionV1 {
  return {
    releaseInstanceId: "ri-1",
    integrationNodeId: NODE,
    provider: "fly",
    environment: "production",
    deploymentId: "dep-1",
    artifactDigest: ARTIFACT,
    sourceRef: "mainsha1",
    behaviorCount: 3,
    behaviorsPassed: 3,
    behaviorsFailed: 0,
    scenarioKeys: ["button/light/desktop", "card/dark/mobile"],
    ...overrides,
  };
}

function evidence(overrides: Partial<DesignDeliveryEvidence> = {}): DesignDeliveryEvidence {
  return {
    orgId: "org1",
    projectId: "proj1",
    runId: "run1",
    integrationNodeId: NODE,
    preMerge: preMerge(),
    production: production(),
    deployVerified: true,
    ...overrides,
  };
}

describe("ds-6 DesignDeliveryProofV1 equivalence (the verified join)", () => {
  it("is `equivalent` (A4 ≡ demo) when every precondition holds", () => {
    expect(deriveEquivalence(evidence())).toBe("equivalent");
  });

  it("builds a strict proof that round-trips and carries the bound key ONLY when equivalent", () => {
    const proof = buildDesignDeliveryProof(evidence());
    expect(() => parseDesignDeliveryProof(proof)).not.toThrow();
    expect(DesignDeliveryProofV1.safeParse(proof).success).toBe(true);
    expect(proof.equivalence).toBe("equivalent");
    expect(proof.boundKey).not.toBeNull();
    expect(proof.boundKey?.artifactDigest).toBe(ARTIFACT);
    // No client success boolean exists on the shape.
    expect((proof as unknown as Record<string, unknown>)["success"]).toBeUndefined();
  });

  it("blocks when the pre-merge binding is absent", () => {
    expect(deriveEquivalence(evidence({ preMerge: undefined }))).toBe("blocked_pre_merge_incomplete");
  });

  it("blocks when the pre-merge binding is for a DIFFERENT integration node", () => {
    expect(deriveEquivalence(evidence({ preMerge: preMerge({ integrationNodeId: "other-node" }) }))).toBe(
      "blocked_pre_merge_incomplete",
    );
  });

  it("blocks on an empty eager matrix (no vacuous pass)", () => {
    expect(deriveEquivalence(evidence({ preMerge: preMerge({ cells: [], scenarioKeys: [] }) }))).toBe(
      "blocked_pre_merge_incomplete",
    );
  });

  it("blocks when the render verdict outcome is not `passed`", () => {
    expect(deriveEquivalence(evidence({ preMerge: preMerge({ renderOutcome: "failed_visual" }) }))).toBe(
      "blocked_render_not_passed",
    );
  });

  it("blocks when ANY eager cell did not render `passed` (partial matrix)", () => {
    const pm = preMerge();
    const partial = preMerge({
      cells: [pm.cells[0]!, { ...pm.cells[1]!, renderVerdict: "failed" }],
    });
    expect(deriveEquivalence(evidence({ preMerge: partial }))).toBe("blocked_render_not_passed");
  });

  it("blocks when there is no live production release", () => {
    expect(deriveEquivalence(evidence({ production: undefined }))).toBe("blocked_no_live_release");
  });

  it("blocks when the live release binds to a DIFFERENT integration node than the pre-merge matrix", () => {
    expect(deriveEquivalence(evidence({ production: production({ integrationNodeId: "other-node" }) }))).toBe(
      "blocked_node_mismatch",
    );
  });

  it("NEGATIVE CONTROL: blocks a CHANGED live artifact digest (different bytes claimed as delivered)", () => {
    expect(deriveEquivalence(evidence({ production: production({ artifactDigest: SHA("f") }) }))).toBe(
      "blocked_artifact_mismatch",
    );
  });

  it("blocks when the deploy is not verified", () => {
    expect(deriveEquivalence(evidence({ deployVerified: false }))).toBe("blocked_deploy_unverified");
  });

  it("NEGATIVE CONTROL: blocks a CHANGED live scenario set that does not equal the pre-merge matrix", () => {
    expect(deriveEquivalence(evidence({ production: production({ scenarioKeys: ["button/light/desktop"] }) }))).toBe(
      "blocked_scenario_mismatch",
    );
  });

  it("NEGATIVE CONTROL: blocks a 200-but-failing demo (a behavior failed its acceptance assertion)", () => {
    expect(
      deriveEquivalence(
        evidence({ production: production({ behaviorCount: 3, behaviorsPassed: 2, behaviorsFailed: 1 }) }),
      ),
    ).toBe("blocked_demo_not_passed");
  });

  it("NEGATIVE CONTROL: blocks a zero-behavior release (nothing proven live — never a vacuous pass)", () => {
    expect(
      deriveEquivalence(
        evidence({ production: production({ behaviorCount: 0, behaviorsPassed: 0, behaviorsFailed: 0 }) }),
      ),
    ).toBe("blocked_demo_not_passed");
  });

  it("a blocked proof carries NO bound key (equivalence never leaks on failure)", () => {
    const proof = buildDesignDeliveryProof(evidence({ production: production({ artifactDigest: SHA("f") }) }));
    expect(proof.equivalence).toBe("blocked_artifact_mismatch");
    expect(proof.boundKey).toBeNull();
    expect(proof.production).not.toBeNull();
  });
});
