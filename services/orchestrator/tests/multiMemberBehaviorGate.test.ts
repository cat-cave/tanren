// cspell:ignore inode
// rv-gate fix #2 — the MQ-2 multi-member (batch) land must consult the per-member runtime
// behavior gate. A batch lands the whole node as one head, so ANY member with a required,
// non-passing behavior must block the whole land. This proves (a) the pure fold
// `gateVerdictWithBehaviorGates` and (b) end-to-end: a member's failed_product behavior forces
// the batch gate verdict to `failed`, so `evaluateMultiMemberAuthority` does NOT authorize the
// subset — the batch member does not land.

import { describe, expect, it } from "vitest";
import { memberKey, proofReuseKey, type ProofReuseKeyInput } from "../src/engine/contracts/integrationNodes.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import type { AuthorizeLandInput, LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import {
  MergeAuthorityV2Impl,
  SubjectEqualityRevalidator,
  type AuthorityLandStore,
} from "../src/engine/merge/mergeAuthorityV2Impl.js";
import {
  gateVerdictWithBehaviorGates,
  gateVerdictWithDesignRenderGates,
} from "../src/engine/merge/multiMemberAuthorityPgState.js";
import { evaluateMultiMemberAuthority } from "../src/engine/merge/multiMemberAuthorityEvaluator.js";
import { batchArtifactDigest, batchProofRoot } from "../src/engine/merge/multiMemberAuthorityTypes.js";

const KEY_INPUT: ProofReuseKeyInput = {
  memberKey: "",
  gateConfigHash: "gate-7",
  policyVersion: "policy-9",
  runnerImage: "runner@sha256:exact",
  appEnvHash: "env-2",
  quarantineVersion: "quarantine-4",
};

function binding(): BatchAuthorityBinding {
  const members = [
    { specId: "A", runId: "run-a", branch: "tanren/a", headSha: "head-a" },
    { specId: "B", runId: "run-b", branch: "tanren/b", headSha: "head-b" },
  ];
  const memberSetHash = memberKey(
    "main-before",
    members.map((member) => member.headSha),
  );
  const keyInput = { ...KEY_INPUT, memberKey: memberSetHash };
  return {
    nodeId: "inode-batch-42",
    baseBranch: "main",
    baseSha: "main-before",
    headSha: "batch-head",
    treeHash: "batch-tree",
    members,
    memberSetHash,
    policyVersion: keyInput.policyVersion,
    proof: { verdict: "passed", proofReuseKey: proofReuseKey(keyInput), keyInput },
  };
}

function envelope(exact: BatchAuthorityBinding): LandBindingEnvelope {
  return {
    subject: { kind: "integration_node", id: exact.nodeId },
    members: exact.members.map((member) => ({ ...member, disposition: "admit" })),
    headSha: exact.headSha,
    expectedMainSha: exact.baseSha,
    artifactDigest: batchArtifactDigest(exact),
    proofRoot: batchProofRoot(exact),
    memberSetHash: exact.memberSetHash,
    policyVersion: exact.policyVersion,
    target: { repo: { owner: "cat-cave", name: "tanren" }, intoMain: "main" },
  };
}

function decision(exact: BatchAuthorityBinding, gateVerdict: AuthorizeLandInput["gateVerdict"]): AuthorizeLandInput {
  return {
    subject: { kind: "integration_node", id: exact.nodeId },
    gateVerdict,
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    reviewVerdict: "approved",
    mergeability: "clean",
    budget: { kind: "not_required" },
    demo: "not_required",
    hitlSignoff: "not_required",
    conflicts: "resolved",
  };
}

function authority(): Pick<MergeAuthorityV2Impl, "authorizeLand"> {
  const host = {
    landAuthorizedIntegration: async () => ({ mainSha: "x" }),
  } as unknown as CodeHost;
  const store = {
    persistAuthorizedDecision: async () => ({ effectIntentId: "i" }),
    recordLandReceipt: async () => ({ auditId: "a" }),
  } as unknown as AuthorityLandStore;
  return new MergeAuthorityV2Impl(host, new SubjectEqualityRevalidator(), store);
}

describe("gateVerdictWithBehaviorGates — the MQ-2 per-member behavior fold", () => {
  it("all members not_applicable → passes the persisted gate verdict through unchanged", () => {
    expect(gateVerdictWithBehaviorGates("passed", [{ kind: "not_applicable" }, { kind: "not_applicable" }])).toBe(
      "passed",
    );
  });

  it("a member with a passed behavior → passthrough (does not spuriously block a good batch)", () => {
    expect(gateVerdictWithBehaviorGates("passed", [{ kind: "passed", passedBlockingCount: 1 }])).toBe("passed");
  });

  it("ANY member failed → the batch gate verdict is forced to failed (fail closed)", () => {
    expect(
      gateVerdictWithBehaviorGates("passed", [
        { kind: "not_applicable" },
        { kind: "failed", behaviorRevisionId: "br-x", outcome: "failed_product" },
      ]),
    ).toBe("failed");
  });

  it("ANY member inconclusive → the batch gate verdict is forced to failed (fail closed)", () => {
    expect(gateVerdictWithBehaviorGates("passed", [{ kind: "inconclusive", reason: "still running" }])).toBe("failed");
  });
});

describe("gateVerdictWithDesignRenderGates — the MQ-2 per-member design-render fold", () => {
  it("all members not_applicable / passed → passes the persisted gate verdict through unchanged", () => {
    expect(
      gateVerdictWithDesignRenderGates("passed", [
        { kind: "not_applicable" },
        { kind: "passed", passedCheckpointCount: 2 },
      ]),
    ).toBe("passed");
  });

  it("ANY member failed design render → the batch gate verdict is forced to failed (fail closed)", () => {
    expect(
      gateVerdictWithDesignRenderGates("passed", [
        { kind: "not_applicable" },
        { kind: "failed", failingScenarioKey: "button:dark:mobile:en-US", failingRuleIds: ["button-name"] },
      ]),
    ).toBe("failed");
  });

  it("ANY member inconclusive design render → the batch gate verdict is forced to failed (fail closed)", () => {
    expect(gateVerdictWithDesignRenderGates("passed", [{ kind: "inconclusive", reason: "required-but-absent" }])).toBe(
      "failed",
    );
  });
});

describe("MQ-2 batch land — a member with a required failed_product behavior does NOT land", () => {
  it("the folded gateVerdict='failed' makes evaluateMultiMemberAuthority refuse to authorize the subset", async () => {
    const exact = binding();
    // The production gather folds member B's failed_product behavior into the batch decision:
    const gateVerdict = gateVerdictWithBehaviorGates("passed", [
      { kind: "not_applicable" },
      { kind: "failed", behaviorRevisionId: "br-b", outcome: "failed_product" },
    ]);
    expect(gateVerdict).toBe("failed");
    const result = await evaluateMultiMemberAuthority({
      binding: exact,
      entries: [
        { specId: "A", runId: "run-a", dependsOn: [] },
        { specId: "B", runId: "run-b", dependsOn: [] },
      ],
      decisionInput: decision(exact, gateVerdict),
      envelope: envelope(exact),
      authority: authority(),
      memberFindings: [],
    });
    // The batch is NOT authorized — no member lands (embark would `hold`, never land the group).
    expect(result.kind).not.toBe("authorized_subset");
  });

  it("with every member's behavior clear (not_applicable) the SAME batch authorizes (no over-blocking)", async () => {
    const exact = binding();
    const gateVerdict = gateVerdictWithBehaviorGates("passed", [
      { kind: "not_applicable" },
      { kind: "not_applicable" },
    ]);
    const result = await evaluateMultiMemberAuthority({
      binding: exact,
      entries: [
        { specId: "A", runId: "run-a", dependsOn: [] },
        { specId: "B", runId: "run-b", dependsOn: [] },
      ],
      decisionInput: decision(exact, gateVerdict),
      envelope: envelope(exact),
      authority: authority(),
      memberFindings: [],
    });
    expect(result.kind).toBe("authorized_subset");
  });
});
