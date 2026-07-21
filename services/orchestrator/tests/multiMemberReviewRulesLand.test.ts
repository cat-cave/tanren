// gv-12 P0 fail-open repair — the MQ-2 multi-member (batch) land must enforce the DEDICATED
// review rules, not merely a generic aggregated `review.approved`. A batch lands the whole node
// as one head, so ANY member whose immutable review rules BLOCK (no dedicated reviewer, missing
// forge receipt, below the minimum approval count, wrong actor, or a stale/base-shifted receipt)
// must block the whole land. This proves (a) the pure fold `gateVerdictWithReviewRules`, (b) the
// per-member `evaluateMemberReviewRules` over real evidence, and (c) end-to-end: a folded
// gateVerdict='failed' makes `evaluateMultiMemberAuthority` refuse to authorize the subset — the
// batch member does NOT land. It also proves the P2 dismiss-on-base-shift enforcement.

import { describe, expect, it } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import type { AuthorizeLandInput, LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import {
  DEDICATED_REVIEWER_PRINCIPAL,
  evaluateReviewRules,
  reviewRulesFromCompiledPolicy,
  type GovernanceReviewGate,
} from "../src/engine/governance/reviewRules.js";
import {
  MergeAuthorityV2Impl,
  SubjectEqualityRevalidator,
  type AuthorityLandStore,
} from "../src/engine/merge/mergeAuthorityV2Impl.js";
import {
  evaluateMemberReviewRules,
  gateVerdictWithReviewRules,
} from "../src/engine/merge/multiMemberAuthorityPgState.js";
import { evaluateMultiMemberAuthority } from "../src/engine/merge/multiMemberAuthorityEvaluator.js";
import { batchArtifactDigest, batchProofRoot } from "../src/engine/merge/multiMemberAuthorityTypes.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const OLD_HEAD = "c".repeat(40);

// A standard-tier-shaped review policy: a dedicated `tanren-reviewer` principal, a complete
// forge receipt, and `branch_head` freshness with `dismiss_on_base_shift` (exercises the P2 fix).
function simulatedReviewGate(evidence: GovernanceReviewGate["evidence"]): GovernanceReviewGate {
  const compiled = compilePolicy({
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: { rules: [] },
    org: { rules: [] },
    tier: {
      rules: [
        { key: "review.mode", value: "simulated" },
        { key: "review.minimum_approvals", value: 1 },
        { key: "review.freshness", value: "branch_head" },
        { key: "review.require_forge_publication", value: true },
        { key: "review.dismiss_on_base_shift", value: true },
        { key: "review.required_principal", value: { kind: "agent_profile", name: "tanren-reviewer" } },
      ],
    },
    binding: { rules: [] },
  });
  if (compiled.status !== "compiled") throw new Error("test policy must compile");
  return { rules: reviewRulesFromCompiledPolicy(compiled.ast), evidence };
}

function dedicatedApproval(headSha: string): GovernanceReviewGate["evidence"] {
  return {
    kind: "observed",
    approvals: [
      { reviewer: "tanren-reviewer[bot]", principal: DEDICATED_REVIEWER_PRINCIPAL, forgeReviewHeadSha: headSha },
    ],
  };
}

function binding(): BatchAuthorityBinding {
  const members = [
    { specId: "A", runId: "run-a", branch: "tanren/a", headSha: HEAD_A },
    { specId: "B", runId: "run-b", branch: "tanren/b", headSha: HEAD_B },
  ];
  const memberSetHash = memberKey(
    "main-before",
    members.map((member) => member.headSha),
  );
  return {
    nodeId: "inode-batch-77",
    baseBranch: "main",
    baseSha: "main-before",
    headSha: "batch-head",
    treeHash: "batch-tree",
    members,
    memberSetHash,
    gateConfigHash: "gate-7",
    policyVersion: "policy-9",
    proof: {
      verdict: "passed",
      keyInput: {
        memberKey: memberSetHash,
        gateConfigHash: "gate-7",
        policyVersion: "policy-9",
        runnerImage: "runner-review-rules",
        appEnvHash: "env-review-rules",
        quarantineVersion: "quarantine-review-rules",
      },
      gateProofBundleId: "gate_proof_bundle:inode-batch-77",
      proofBundleDigest: parseDigest(`sha256:${"c".repeat(64)}`),
      proofRoot: parseDigest(`sha256:${"d".repeat(64)}`),
    },
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

// The production fold: evaluate BOTH members at their own landing heads, then fold into the
// batch gate verdict, exactly as `decisionFromDurableState` does in prod.
function foldedGateVerdict(
  members: ReadonlyArray<{ gate: GovernanceReviewGate; reviewVerdict: "approved" | undefined; headSha: string }>,
): AuthorizeLandInput["gateVerdict"] {
  const evaluations = members.map((member) =>
    evaluateMemberReviewRules({
      reviewGate: member.gate,
      reviewVerdict: member.reviewVerdict,
      headSha: member.headSha,
    }),
  );
  return gateVerdictWithReviewRules("passed", evaluations);
}

async function runBatch(gateVerdict: AuthorizeLandInput["gateVerdict"]) {
  const exact = binding();
  return evaluateMultiMemberAuthority({
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
}

describe("gateVerdictWithReviewRules — the MQ-2 per-member review-rule fold", () => {
  it("all members pass their review rules → passes the persisted gate verdict through unchanged", () => {
    expect(gateVerdictWithReviewRules("passed", [{ kind: "passed" }, { kind: "passed" }])).toBe("passed");
  });

  it("ANY member's review rules block → the batch gate verdict is forced to failed (fail closed)", () => {
    expect(gateVerdictWithReviewRules("passed", [{ kind: "passed" }, { kind: "blocked", reason: "no reviewer" }])).toBe(
      "failed",
    );
  });
});

describe("evaluateMemberReviewRules — per-member dedicated review enforcement", () => {
  it("a bare approval with NO dedicated-reviewer principal blocks", () => {
    const result = evaluateMemberReviewRules({
      reviewGate: simulatedReviewGate({
        kind: "observed",
        approvals: [{ reviewer: "someone", forgeReviewHeadSha: HEAD_A }],
      }),
      reviewVerdict: "approved",
      headSha: HEAD_A,
    });
    expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("tanren-reviewer") });
  });

  it("a wrong-actor (writer self-review) approval blocks", () => {
    const result = evaluateMemberReviewRules({
      reviewGate: simulatedReviewGate({
        kind: "observed",
        approvals: [
          { reviewer: "writer-bot", principal: { kind: "agent_profile", name: "writer" }, forgeReviewHeadSha: HEAD_A },
        ],
      }),
      reviewVerdict: "approved",
      headSha: HEAD_A,
    });
    expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("tanren-reviewer") });
  });

  it("a missing forge receipt below the minimum usable-approval count blocks", () => {
    const result = evaluateMemberReviewRules({
      // Dedicated reviewer but NO forge receipt head → not usable under require_forge_publication.
      reviewGate: simulatedReviewGate({
        kind: "observed",
        approvals: [{ reviewer: "tanren-reviewer[bot]", principal: DEDICATED_REVIEWER_PRINCIPAL }],
      }),
      reviewVerdict: "approved",
      headSha: HEAD_A,
    });
    expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("0/1") });
  });

  it("P2 — a dedicated approval for a since-shifted base (branch_head/dismiss_on_base_shift) is STALE → blocks", () => {
    const result = evaluateMemberReviewRules({
      reviewGate: simulatedReviewGate(dedicatedApproval(OLD_HEAD)),
      reviewVerdict: "approved",
      // The head advanced since the OLD_HEAD approval → dismissed on base shift.
      headSha: HEAD_A,
    });
    expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("0/1") });
  });

  it("a genuine dedicated-reviewer approval at the current head passes", () => {
    const result = evaluateMemberReviewRules({
      reviewGate: simulatedReviewGate(dedicatedApproval(HEAD_A)),
      reviewVerdict: "approved",
      headSha: HEAD_A,
    });
    expect(result).toEqual({ kind: "passed" });
  });
});

describe("evaluateReviewRules — P2 dismiss-on-base-shift is now live (previously dead)", () => {
  const gate = (headSha: string) => simulatedReviewGate(dedicatedApproval(headSha));
  it("a matching branch head is fresh → passes", () => {
    expect(evaluateReviewRules({ gate: gate(HEAD_A), latestVerdict: "approved", landingHeadSha: HEAD_A })).toEqual({
      kind: "passed",
    });
  });
  it("a shifted branch head is stale → blocks (branch_head freshness is no longer a no-op)", () => {
    expect(
      evaluateReviewRules({ gate: gate(OLD_HEAD), latestVerdict: "approved", landingHeadSha: HEAD_A }),
    ).toMatchObject({ kind: "blocked" });
  });
});

describe("MQ-2 batch land — the review-rule fold gates the REAL multi-member authorizer", () => {
  it("a batch≥2 with bare approved events but NO dedicated reviewer does NOT land", async () => {
    const gateVerdict = foldedGateVerdict([
      {
        gate: simulatedReviewGate({
          kind: "observed",
          approvals: [{ reviewer: "someone", forgeReviewHeadSha: HEAD_A }],
        }),
        reviewVerdict: "approved",
        headSha: HEAD_A,
      },
      {
        gate: simulatedReviewGate({
          kind: "observed",
          approvals: [{ reviewer: "another", forgeReviewHeadSha: HEAD_B }],
        }),
        reviewVerdict: "approved",
        headSha: HEAD_B,
      },
    ]);
    expect(gateVerdict).toBe("failed");
    const result = await runBatch(gateVerdict);
    expect(result.kind).not.toBe("authorized_subset");
  });

  it("a wrong-actor (writer self-review) approval does NOT land", async () => {
    const gateVerdict = foldedGateVerdict([
      { gate: simulatedReviewGate(dedicatedApproval(HEAD_A)), reviewVerdict: "approved", headSha: HEAD_A },
      {
        gate: simulatedReviewGate({
          kind: "observed",
          approvals: [
            {
              reviewer: "writer-bot",
              principal: { kind: "agent_profile", name: "writer" },
              forgeReviewHeadSha: HEAD_B,
            },
          ],
        }),
        reviewVerdict: "approved",
        headSha: HEAD_B,
      },
    ]);
    expect(gateVerdict).toBe("failed");
    const result = await runBatch(gateVerdict);
    expect(result.kind).not.toBe("authorized_subset");
  });

  it("a stale approval (base shifted, dismiss_on_base_shift) does NOT land", async () => {
    const gateVerdict = foldedGateVerdict([
      { gate: simulatedReviewGate(dedicatedApproval(HEAD_A)), reviewVerdict: "approved", headSha: HEAD_A },
      { gate: simulatedReviewGate(dedicatedApproval(OLD_HEAD)), reviewVerdict: "approved", headSha: HEAD_B },
    ]);
    expect(gateVerdict).toBe("failed");
    const result = await runBatch(gateVerdict);
    expect(result.kind).not.toBe("authorized_subset");
  });

  it("a genuine dedicated-reviewer approval meeting all rules on EVERY member lands (no over-blocking)", async () => {
    const gateVerdict = foldedGateVerdict([
      { gate: simulatedReviewGate(dedicatedApproval(HEAD_A)), reviewVerdict: "approved", headSha: HEAD_A },
      { gate: simulatedReviewGate(dedicatedApproval(HEAD_B)), reviewVerdict: "approved", headSha: HEAD_B },
    ]);
    expect(gateVerdict).toBe("passed");
    const result = await runBatch(gateVerdict);
    expect(result.kind).toBe("authorized_subset");
  });
});
