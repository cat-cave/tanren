import { describe, expect, it, vi } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { AuthorizeLandInput, LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { memberKey, proofReuseKey } from "../src/engine/contracts/integrationNodes.js";
import { CanonicalQueueAuthorityDrive } from "../src/engine/merge/canonicalQueueAuthorityDrive.js";
import {
  batchArtifactDigest,
  batchProofRoot,
  MULTI_MEMBER_AUTHORITY_VERSION,
  type AuthorizedSubsetEvaluation,
  type BatchAuthorityEvaluator,
} from "../src/engine/merge/multiMemberAuthorityTypes.js";

function exactFixture(): {
  readonly entry: MergeQueueEntry;
  readonly binding: BatchAuthorityBinding;
  readonly evaluation: AuthorizedSubsetEvaluation;
} {
  const member = { specId: "spec-a", runId: "run-a", branch: "tanren/spec-a", headSha: "head-a" };
  const baseSha = "main-a";
  const memberSetHash = memberKey(baseSha, [member.headSha]);
  const keyInput = {
    memberKey: memberSetHash,
    gateConfigHash: "gate-a",
    policyVersion: "policy-a",
    runnerImage: "runner@sha256:a",
    appEnvHash: "env-a",
    quarantineVersion: "quarantine-a",
  };
  const binding: BatchAuthorityBinding = {
    nodeId: "node-a",
    baseBranch: "main",
    baseSha,
    headSha: "integration-a",
    treeHash: "tree-a",
    members: [member],
    memberSetHash,
    policyVersion: keyInput.policyVersion,
    proof: { verdict: "passed", proofReuseKey: proofReuseKey(keyInput), keyInput },
  };
  const envelope: LandBindingEnvelope = {
    subject: { kind: "integration_node", id: binding.nodeId },
    members: [{ ...member, disposition: "admit" }],
    headSha: binding.headSha,
    expectedMainSha: binding.baseSha,
    artifactDigest: batchArtifactDigest(binding),
    proofRoot: batchProofRoot(binding),
    memberSetHash: binding.memberSetHash,
    policyVersion: binding.policyVersion,
    target: { repo: { owner: "org", name: "repo" }, intoMain: "main" },
  };
  const decisionInput: AuthorizeLandInput = {
    subject: envelope.subject,
    gateVerdict: "passed",
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
    reviewVerdict: "approved",
    mergeability: "clean",
    budget: { kind: "not_required" },
    demo: "not_required",
    hitlSignoff: "not_required",
    conflicts: "resolved",
  };
  const authorization = { decision: "authorized" as const, subject: envelope.subject, envelope, reasons: [] };
  const evaluation: AuthorizedSubsetEvaluation = {
    kind: "authorized_subset",
    evaluationId: `mqeval_${"a".repeat(64)}`,
    groupId: `mqgrp_${"b".repeat(64)}`,
    version: MULTI_MEMBER_AUTHORITY_VERSION,
    nodeId: binding.nodeId,
    memberSetHash: binding.memberSetHash,
    proofReuseKey: binding.proof.proofReuseKey,
    members: [{ ...member, disposition: "admit", findingIds: [], reasonCodes: [] }],
    reasonCodes: [],
    authorizedMemberIds: [member.specId],
    eligibleMemberIds: [member.specId],
    decisionInput,
    authorization,
  };
  return {
    entry: {
      orgId: "org",
      projectId: "project",
      queueId: "queue-a",
      runId: member.runId,
      specId: member.specId,
      prUrl: "https://example.test/pr/1",
      prNumber: 1,
      dependsOn: [],
      priority: "P1",
      orderKey: 1,
    },
    binding,
    evaluation,
  };
}

function evaluator(landAuthorizedGroup: NonNullable<BatchAuthorityEvaluator["landAuthorizedGroup"]>): BatchAuthorityEvaluator {
  return { evaluate: vi.fn(), landAuthorizedGroup };
}

describe("CanonicalQueueAuthorityDrive", () => {
  it("hands an exact persisted one-member authorization to the existing group land seam", async () => {
    const fixture = exactFixture();
    const landAuthorizedGroup = vi.fn<NonNullable<BatchAuthorityEvaluator["landAuthorizedGroup"]>>().mockResolvedValue({
      kind: "landed",
      mainSha: fixture.binding.headSha,
    });
    const result = await new CanonicalQueueAuthorityDrive(evaluator(landAuthorizedGroup)).land({
      projectId: fixture.entry.projectId,
      entries: [fixture.entry],
      binding: fixture.binding,
      evaluation: fixture.evaluation,
      confirmBeforeLand: async () => true,
    });

    expect(result).toEqual({ kind: "landed", mainSha: "integration-a" });
    expect(landAuthorizedGroup).toHaveBeenCalledOnce();
    expect(landAuthorizedGroup).toHaveBeenCalledWith(
      expect.objectContaining({ binding: fixture.binding, evaluation: fixture.evaluation }),
    );
  });

  it("rejects changed base, ordered member, or proof root before the land seam", async () => {
    const fixture = exactFixture();
    const landAuthorizedGroup = vi.fn<NonNullable<BatchAuthorityEvaluator["landAuthorizedGroup"]>>();
    const drive = new CanonicalQueueAuthorityDrive(evaluator(landAuthorizedGroup));
    const changedRoot = parseDigest(`sha256:${"f".repeat(64)}`);
    const candidates = [
      { binding: { ...fixture.binding, baseSha: "main-b" }, evaluation: fixture.evaluation },
      {
        binding: {
          ...fixture.binding,
          members: [{ ...fixture.binding.members[0]!, headSha: "head-b" }],
        },
        evaluation: fixture.evaluation,
      },
      {
        binding: fixture.binding,
        evaluation: {
          ...fixture.evaluation,
          authorization: {
            ...fixture.evaluation.authorization,
            envelope: { ...fixture.evaluation.authorization.envelope, proofRoot: changedRoot },
          },
        },
      },
      {
        binding: fixture.binding,
        evaluation: {
          ...fixture.evaluation,
          authorization: {
            ...fixture.evaluation.authorization,
            subject: { kind: "integration_node", id: "unpersisted-node" },
          },
        },
      },
    ];

    for (const candidate of candidates) {
      await expect(
        drive.land({
          projectId: fixture.entry.projectId,
          entries: [fixture.entry],
          binding: candidate.binding,
          evaluation: candidate.evaluation,
          confirmBeforeLand: async () => true,
        }),
      ).resolves.toEqual({ kind: "rederive" });
    }
    expect(landAuthorizedGroup).not.toHaveBeenCalled();
  });
});
