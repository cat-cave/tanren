// cspell:ignore mqeval mqgrp
import { describe, expect, it, vi } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import type {
  AuthorizeLandInput,
  LandBindingEnvelope,
  MergeAuthorityV2,
} from "../src/engine/contracts/mergeAuthority.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { Finding } from "../src/engine/contracts/findings.js";
import {
  MergeAuthorityV2Impl,
  SubjectEqualityRevalidator,
  type AuthorityLandStore,
} from "../src/engine/merge/mergeAuthorityV2Impl.js";
import { evaluateMultiMemberAuthority } from "../src/engine/merge/multiMemberAuthorityEvaluator.js";
import { MultiMemberAuthorityInfrastructureFault } from "../src/engine/merge/multiMemberAuthorityEvidence.js";
import {
  batchArtifactDigest,
  batchProofRoot,
  type EvaluateMultiMemberAuthorityInput,
  type MemberFindingAttribution,
} from "../src/engine/merge/multiMemberAuthorityTypes.js";

const FINDING: Finding = {
  id: "finding-b",
  severity: "P1",
  title: "B violates the product contract",
  body: "The durable member audit attributed this defect to B.",
};

function binding(): BatchAuthorityBinding {
  const members = [
    { specId: "A", runId: "run-a", branch: "tanren/a", headSha: "head-a" },
    { specId: "B", runId: "run-b", branch: "tanren/b", headSha: "head-b" },
    { specId: "C", runId: "run-c", branch: "tanren/c", headSha: "head-c" },
  ];
  const memberSetHash = memberKey(
    "main-before",
    members.map((member) => member.headSha),
  );
  return {
    nodeId: "inode-batch-17",
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
      gateProofBundleId: "gate_proof_bundle:inode-batch-17",
      proofBundleDigest: parseDigest(`sha256:${"a".repeat(64)}`),
      proofRoot: parseDigest(`sha256:${"b".repeat(64)}`),
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

function decision(exact: BatchAuthorityBinding, overrides: Partial<AuthorizeLandInput> = {}): AuthorizeLandInput {
  return {
    subject: { kind: "integration_node", id: exact.nodeId },
    gateVerdict: "passed",
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    reviewVerdict: "approved",
    mergeability: "clean",
    budget: { kind: "not_required" },
    demo: "not_required",
    hitlSignoff: "not_required",
    conflicts: "resolved",
    ...overrides,
  };
}

function authorityHarness(): {
  authority: Pick<MergeAuthorityV2, "authorizeLand">;
  landAuthorizedIntegration: CodeHost["landAuthorizedIntegration"];
  persistAuthorizedDecision: AuthorityLandStore["persistAuthorizedDecision"];
} {
  const landAuthorizedIntegration = vi.fn<CodeHost["landAuthorizedIntegration"]>();
  const persistAuthorizedDecision = vi.fn<AuthorityLandStore["persistAuthorizedDecision"]>();
  const host = { landAuthorizedIntegration } as unknown as CodeHost;
  const store = {
    persistAuthorizedDecision,
    recordLandReceipt: vi.fn<AuthorityLandStore["recordLandReceipt"]>(),
  } as unknown as AuthorityLandStore;
  return {
    authority: new MergeAuthorityV2Impl(host, new SubjectEqualityRevalidator(), store),
    landAuthorizedIntegration,
    persistAuthorizedDecision,
  };
}

function evaluationInput(
  overrides: {
    decision?: Partial<AuthorizeLandInput>;
    memberFindings?: ReadonlyArray<MemberFindingAttribution>;
    binding?: BatchAuthorityBinding;
    envelope?: LandBindingEnvelope;
    authority?: Pick<MergeAuthorityV2, "authorizeLand">;
    evidence?: EvaluateMultiMemberAuthorityInput["evidence"];
  } = {},
): EvaluateMultiMemberAuthorityInput {
  const exact = overrides.binding ?? binding();
  const harness = authorityHarness();
  return {
    binding: exact,
    entries: [
      { specId: "A", runId: "run-a", dependsOn: [] },
      { specId: "B", runId: "run-b", dependsOn: [] },
      { specId: "C", runId: "run-c", dependsOn: ["B"] },
    ],
    decisionInput: decision(exact, overrides.decision),
    envelope: overrides.envelope ?? envelope(exact),
    authority: overrides.authority ?? harness.authority,
    memberFindings: overrides.memberFindings ?? [],
    ...(overrides.evidence !== undefined && { evidence: overrides.evidence }),
  };
}

describe("MQ-2 exact multi-member authority evaluation", () => {
  it("returns authorized_subset only for the exact all-admit node and never lands", async () => {
    const harness = authorityHarness();
    const result = await evaluateMultiMemberAuthority(evaluationInput({ authority: harness.authority }));

    expect(result).toMatchObject({
      kind: "authorized_subset",
      nodeId: "inode-batch-17",
      authorizedMemberIds: ["A", "B", "C"],
      eligibleMemberIds: ["A", "B", "C"],
    });
    expect(result.evaluationId).toMatch(/^mqeval_[0-9a-f]{64}$/u);
    expect(result.groupId).toMatch(/^mqgrp_[0-9a-f]{64}$/u);
    expect(harness.landAuthorizedIntegration).not.toHaveBeenCalled();
    expect(harness.persistAuthorizedDecision).not.toHaveBeenCalled();
  });

  it("fails closed when a permissive authority authorizes despite blocking evidence (positive-signal guard)", async () => {
    // The green path is derived from a genuinely-clean authorized decision, NOT from the
    // absence of a fail-closed classification: an authority that returns `authorized` while
    // the exact decision input carries a blocking finding must NOT reach authorized_subset.
    const result = await evaluateMultiMemberAuthority(
      evaluationInput({
        decision: { findings: [FINDING] },
        authority: {
          authorizeLand: vi.fn<MergeAuthorityV2["authorizeLand"]>(async (input, env) => ({
            decision: "authorized",
            reasons: [],
            subject: input.subject,
            envelope: env,
          })),
        },
      }),
    );
    expect(result.kind).toBe("unknown_fail_closed");
    expect(result.reasonCodes).toContain("authorized_with_blocking_evidence");
    expect(result.eligibleMemberIds).toEqual([]);
  });

  it("attributes member policy, excludes B, dependency-holds C, and leaves A eligible", async () => {
    const result = await evaluateMultiMemberAuthority(
      evaluationInput({
        decision: { findings: [FINDING] },
        memberFindings: [{ specId: "B", runId: "run-b", findings: [FINDING] }],
      }),
    );

    expect(result).toMatchObject({
      kind: "member_failure",
      failedMemberIds: ["B"],
      heldMemberIds: ["C"],
      eligibleMemberIds: ["A"],
      findingIds: ["finding-b"],
      w0: {
        missionNodeId: "mq-1",
        classification: "deterministic_policy",
        memberIds: ["B"],
        findingIds: ["finding-b"],
      },
    });
    expect(result.members.map(({ specId, disposition }) => [specId, disposition])).toEqual([
      ["A", "admit"],
      ["B", "exclude"],
      ["C", "hold"],
    ]);
  });

  it("fails unattributed multi-member policy closed and embarks nobody", async () => {
    const result = await evaluateMultiMemberAuthority(evaluationInput({ decision: { findings: [FINDING] } }));

    expect(result.kind).toBe("unknown_fail_closed");
    expect(result.eligibleMemberIds).toEqual([]);
    expect(result.reasonCodes).toContain("blocking_finding_unattributed");
    expect(result.w0).toMatchObject({ classification: "unknown_fail_closed", reasonCode: "unattributed_policy" });
  });

  it("maps a genuine review decision to needs_product_decision", async () => {
    const result = await evaluateMultiMemberAuthority(
      evaluationInput({ decision: { reviewVerdict: "changes_requested" } }),
    );
    expect(result).toMatchObject({
      kind: "needs_product_decision",
      eligibleMemberIds: [],
      w0: { classification: "needs_product_decision", reasonCode: "review_changes_requested" },
    });
  });

  it("fails a residual non-attributable authority block closed (never interaction_failure) at the post-pass site", async () => {
    // A residual block that is not member-attributable policy, typed infra, or a product
    // decision is unknown_fail_closed. interaction_failure is NOT an engine post-pass
    // disposition — it is reconstructed by the durable HTTP read side from a FAILED batch
    // proof (which the post-pass evaluator, running only after a PASS, can never observe).
    const result = await evaluateMultiMemberAuthority(evaluationInput({ decision: { conflicts: "unresolved" } }));
    expect(result.kind).toBe("unknown_fail_closed");
    expect(result.eligibleMemberIds).toEqual([]);
    expect(result.members.every((member) => member.disposition === "hold")).toBe(true);
    expect(result.reasonCodes).toContain("authority_blocked_fail_closed");
  });

  it("maps typed infrastructure without member blame", async () => {
    const result = await evaluateMultiMemberAuthority(
      evaluationInput({
        evidence: { kind: "infrastructure", reasonCode: "runner_transport", sourceKey: "runner:batch-17" },
      }),
    );
    expect(result).toMatchObject({
      kind: "transient_infrastructure",
      eligibleMemberIds: [],
      w0: { classification: "transient_infrastructure", reasonCode: "runner_transport", memberIds: [] },
    });
  });

  it("classifies only a typed authority outage as infrastructure; a generic throw remains unknown", async () => {
    const typed = await evaluateMultiMemberAuthority(
      evaluationInput({
        authority: {
          authorizeLand: vi.fn<MergeAuthorityV2["authorizeLand"]>().mockRejectedValue(
            new MultiMemberAuthorityInfrastructureFault({
              kind: "infrastructure",
              reasonCode: "code_host_unavailable",
              sourceKey: "mq2:inode-batch-17:code-host",
            }),
          ),
        },
      }),
    );
    const untyped = await evaluateMultiMemberAuthority(
      evaluationInput({
        authority: {
          authorizeLand: vi
            .fn<MergeAuthorityV2["authorizeLand"]>()
            .mockRejectedValue(new Error("bad credential config")),
        },
      }),
    );

    expect(typed).toMatchObject({
      kind: "transient_infrastructure",
      w0: { classification: "transient_infrastructure", reasonCode: "code_host_unavailable" },
    });
    expect(untyped).toMatchObject({ kind: "unknown_fail_closed", reasonCodes: ["authority_evaluation_threw"] });
  });

  it("keeps uncertain authority state unknown instead of relabeling it interaction or infra", async () => {
    const result = await evaluateMultiMemberAuthority(evaluationInput({ decision: { mergeability: "unknown" } }));
    expect(result).toMatchObject({
      kind: "unknown_fail_closed",
      eligibleMemberIds: [],
      w0: { classification: "unknown_fail_closed", reasonCode: "unclassified_authority_block" },
    });
  });

  it("rejects stale proof/head identity before invoking the authority", async () => {
    const exact = binding();
    const authorizeLand = vi.fn<MergeAuthorityV2["authorizeLand"]>();
    const shiftedEnvelope = { ...envelope(exact), headSha: "different-head" };
    const result = await evaluateMultiMemberAuthority(
      evaluationInput({ binding: exact, envelope: shiftedEnvelope, authority: { authorizeLand } }),
    );

    expect(result.kind).toBe("unknown_fail_closed");
    expect(result.reasonCodes).toContain("land_envelope_identity_mismatch");
    expect(authorizeLand).not.toHaveBeenCalled();
  });

  it("rejects an excluded member on the original full head before authorization", async () => {
    const exact = binding();
    const authorizeLand = vi.fn<MergeAuthorityV2["authorizeLand"]>();
    const excludedEnvelope: LandBindingEnvelope = {
      ...envelope(exact),
      members: envelope(exact).members.map((member) =>
        member.specId === "B" ? { ...member, disposition: "exclude" } : member,
      ),
    };
    const result = await evaluateMultiMemberAuthority(
      evaluationInput({ binding: exact, envelope: excludedEnvelope, authority: { authorizeLand } }),
    );
    expect(result.kind).toBe("unknown_fail_closed");
    expect(result.reasonCodes).toContain("ordered_member_binding_mismatch");
    expect(authorizeLand).not.toHaveBeenCalled();
  });
});
