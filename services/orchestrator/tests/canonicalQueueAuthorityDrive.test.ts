// cspell:ignore rederive
import { describe, expect, it, vi } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import type {
  AuthorizeLandInput,
  LandBindingEnvelope,
  MergeAuthorityV2,
} from "../src/engine/contracts/mergeAuthority.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import { CanonicalQueueAuthorityDrive } from "../src/engine/merge/canonicalQueueAuthorityDrive.js";
import { evaluateMultiMemberAuthority } from "../src/engine/merge/multiMemberAuthorityEvaluator.js";
import { rethrowTypedCodeHostInfrastructure } from "../src/engine/merge/multiMemberAuthorityEvidencePg.js";
import {
  buildMultiMemberEnvelope,
  gatherMultiMemberAuthorityState,
  gateVerdictWithBehaviorGates,
  gateVerdictWithDesignRenderGates,
  gateVerdictWithReviewRules,
  loadMultiMemberLandContext,
} from "../src/engine/merge/multiMemberAuthorityPgState.js";
import { solveSafeSubset } from "../src/engine/merge/safeSubsetSolver.js";
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
  const binding: BatchAuthorityBinding = {
    nodeId: "node-a",
    baseBranch: "main",
    baseSha,
    headSha: "integration-a",
    treeHash: "tree-a",
    members: [member],
    memberSetHash,
    gateConfigHash: "gate-a",
    policyVersion: "policy-a",
    proof: {
      verdict: "passed",
      gateProofBundleId: "gate_proof_bundle:node-a",
      proofBundleDigest: parseDigest(`sha256:${"c".repeat(64)}`),
      proofRoot: parseDigest(`sha256:${"d".repeat(64)}`),
    },
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
    proofRoot: binding.proof.proofRoot,
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

function evaluator(
  landAuthorizedGroup: NonNullable<BatchAuthorityEvaluator["landAuthorizedGroup"]>,
): BatchAuthorityEvaluator {
  return { evaluate: vi.fn<BatchAuthorityEvaluator["evaluate"]>(), landAuthorizedGroup };
}

function authorizedSubset(ids: ReadonlyArray<string>): object {
  return {
    kind: "authorized_subset",
    members: ids.map((specId) => ({ specId, disposition: "admit" })),
    authorizedMemberIds: ids,
    eligibleMemberIds: ids,
  };
}

class ScopedReadClient {
  constructor(private readonly rowsFor: (sql: string) => ReadonlyArray<object>) {}

  async query<Row extends object>(sql: string): Promise<{ rows: Row[]; rowCount: number }> {
    const rows = this.rowsFor(sql) as Row[];
    return { rows, rowCount: rows.length };
  }

  release(): void {}
}

function scopedPool(rowsFor: ConstructorParameters<typeof ScopedReadClient>[0]) {
  const client = new ScopedReadClient(rowsFor);
  return { connect: async () => client };
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

  it("fails malformed canonical node/proof inputs before authority evaluation", async () => {
    const fixture = exactFixture();
    const authorizeLand = vi.fn<MergeAuthorityV2["authorizeLand"]>();
    const result = await evaluateMultiMemberAuthority({
      binding: {
        ...fixture.binding,
        nodeId: "",
        headSha: "",
        treeHash: "",
        proof: { ...fixture.binding.proof, verdict: "failed" },
      },
      entries: [fixture.entry],
      decisionInput: fixture.evaluation.decisionInput,
      envelope: fixture.evaluation.authorization.envelope,
      memberFindings: [],
      authority: { authorizeLand },
    } as never);

    expect(result.kind).toBe("unknown_fail_closed");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "invalid_canonical_queue_node",
        "missing_materialized_head",
        "passing_proof_binding_mismatch",
      ]),
    );
    expect(authorizeLand).not.toHaveBeenCalled();
  });

  it("keeps direct blame, interaction evidence, and no-blame observations out of authorization", () => {
    const members = [
      { specId: "a", dependsOn: [], weight: 2 },
      { specId: "b", dependsOn: ["a"], weight: 1 },
    ];
    const direct = solveSafeSubset({
      members,
      evaluation: {
        kind: "member_failure",
        members: [
          { specId: "a", disposition: "exclude" },
          { specId: "b", disposition: "hold" },
        ],
        failedMemberIds: ["a"],
        eligibleMemberIds: [],
      } as never,
    });
    expect(direct).toMatchObject({
      proposedMemberIds: [],
      excludedMemberIds: ["a"],
      heldMemberIds: ["b"],
      status: "candidate_requires_authorization",
    });

    const flake = solveSafeSubset({
      members,
      evaluation: { kind: "flake_observation", members: [], eligibleMemberIds: [] } as never,
    });
    expect(flake).toMatchObject({ proposedMemberIds: ["a", "b"], status: "deferred_no_constraint" });

    const interaction = solveSafeSubset({
      members,
      evaluation: { kind: "interaction_failure", members: [], eligibleMemberIds: ["a", "b"] } as never,
      probe: (ids) =>
        ids.length === 2
          ? ({ kind: "interaction_failure", members: [], eligibleMemberIds: ids } as never)
          : (authorizedSubset(ids) as never),
    });
    expect(interaction).toMatchObject({ proposedMemberIds: ["a"], status: "maximal_safe", provenByExactProbe: true });
    expect(interaction.interactionSets).toEqual([["a", "b"]]);

    const capped = solveSafeSubset({
      members,
      evaluation: authorizedSubset(["a", "b"]) as never,
      probe: (ids) => authorizedSubset(ids) as never,
      maxSubsetCandidates: 0,
    });
    expect(capped).toMatchObject({ proposedMemberIds: [], status: "unresolved" });
  });

  it("folds each canonical member's durable gates into the group authority input", () => {
    const fixture = exactFixture();
    expect(buildMultiMemberEnvelope(fixture.binding, { owner: "org", name: "repo" }, "main")).toMatchObject({
      headSha: fixture.binding.headSha,
      expectedMainSha: fixture.binding.baseSha,
    });
    expect(gateVerdictWithBehaviorGates("passed", [{ kind: "inconclusive", reason: "missing behavior proof" }])).toBe(
      "failed",
    );
    expect(
      gateVerdictWithDesignRenderGates("passed", [{ kind: "failed", failingScenarioKey: "home", failingRuleIds: [] }]),
    ).toBe("failed");
    expect(gateVerdictWithReviewRules("passed", [{ kind: "blocked", reason: "missing approval" }])).toBe("failed");
  });

  it("refuses an absent owner or cross-org member before reading canonical authority signals", async () => {
    const fixture = exactFixture();
    const missingOwner = scopedPool((sql) =>
      sql.includes("FROM projects")
        ? [
            {
              org_id: null,
              repo_url: "https://example.test/org/repo",
              default_branch: "main",
              project_config: {},
              org_config: {},
            },
          ]
        : [],
    );
    await expect(
      gatherMultiMemberAuthorityState(
        missingOwner as never,
        { verifyExact: async () => false },
        {
          projectId: fixture.entry.projectId,
          entries: [fixture.entry],
          binding: fixture.binding,
        },
      ),
    ).rejects.toThrow("has no owning org");

    const owner = scopedPool((sql) =>
      sql.includes("FROM projects")
        ? [
            {
              org_id: fixture.entry.orgId,
              repo_url: "https://example.test/org/repo",
              default_branch: "main",
              project_config: {},
              org_config: {},
            },
          ]
        : [],
    );
    await expect(
      gatherMultiMemberAuthorityState(
        owner as never,
        { verifyExact: async () => false },
        {
          projectId: fixture.entry.projectId,
          entries: [{ ...fixture.entry, orgId: "other-org" }],
          binding: fixture.binding,
        },
      ),
    ).rejects.toThrow("batch crosses its project/org boundary");
  });

  it("loads a native-queue land context only for a nonempty batch with a durable tail task", async () => {
    const fixture = exactFixture();
    const withTask = scopedPool((sql) => (sql.includes("FROM tasks") ? [{ task_id: "task-merge" }] : []));
    await expect(
      loadMultiMemberLandContext(
        withTask as never,
        fixture.entry.orgId,
        { projectId: fixture.entry.projectId, entries: [fixture.entry] },
        1,
      ),
    ).resolves.toMatchObject({ taskId: "task-merge", integration: "native_queue" });

    await expect(
      loadMultiMemberLandContext(
        withTask as never,
        fixture.entry.orgId,
        { projectId: fixture.entry.projectId, entries: [] },
        1,
      ),
    ).rejects.toThrow("cannot bind a land store to an empty batch");

    const withoutTask = scopedPool(() => []);
    await expect(
      loadMultiMemberLandContext(
        withoutTask as never,
        fixture.entry.orgId,
        { projectId: fixture.entry.projectId, entries: [fixture.entry] },
        1,
      ),
    ).rejects.toThrow("has no durable merge task");
  });

  it("preserves ordinary evidence faults and promotes retriable host faults to typed infrastructure", () => {
    const fixture = exactFixture();
    const ordinary = new Error("malformed evidence fixture");
    expect(() => rethrowTypedCodeHostInfrastructure(ordinary, fixture.binding)).toThrow(ordinary);

    const retriable = Object.assign(new Error("host unavailable"), { retriable: true });
    expect(() => rethrowTypedCodeHostInfrastructure(retriable, fixture.binding)).toThrow("code_host_unavailable");
  });
});
