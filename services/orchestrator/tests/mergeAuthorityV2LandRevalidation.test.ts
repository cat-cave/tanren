// mq-16 — the authority must revalidate the exact integration binding at land time.

import { describe, expect, it, vi } from "vitest";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import { memberKey, type IntegrationNode } from "../src/engine/contracts/integrationNodes.js";
import type { AuthorizeLandInput, LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import type { PgIntegrationNodeModel } from "../src/engine/dag/integrationNodesPg.js";
import { MergeAuthorityV2Impl, type AuthorityLandStore } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import { PgExactBatchBindingRevalidator } from "../src/engine/merge/multiMemberAuthorityPgAuthority.js";
import { batchArtifactDigest, batchProofRoot } from "../src/engine/merge/multiMemberAuthorityTypes.js";

interface RevalidationState {
  node: IntegrationNode | undefined;
  gateProofValid: boolean;
  readonly refs: Map<string, string>;
}

function binding(): BatchAuthorityBinding {
  const members = [
    { specId: "spec-a", runId: "run-a", branch: "feature/a", headSha: "member-a" },
    { specId: "spec-b", runId: "run-b", branch: "feature/b", headSha: "member-b" },
  ];
  const memberSetHash = memberKey(
    "main-before",
    members.map((member) => member.headSha),
  );
  return {
    nodeId: "inode-mq16",
    baseBranch: "main",
    baseSha: "main-before",
    headSha: "integration-head",
    treeHash: "integration-tree",
    members,
    memberSetHash,
    gateConfigHash: "gate-v1",
    policyVersion: "policy-v1",
    proof: {
      verdict: "passed",
      gateProofBundleId: "gate_proof_bundle:inode-mq16",
      proofBundleDigest: `sha256:${"a".repeat(64)}` as BatchAuthorityBinding["proof"]["proofBundleDigest"],
      proofRoot: `sha256:${"b".repeat(64)}` as BatchAuthorityBinding["proof"]["proofRoot"],
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

function allClear(value: LandBindingEnvelope): AuthorizeLandInput {
  return {
    subject: value.subject,
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
}

function persistedNode(exact: BatchAuthorityBinding): IntegrationNode {
  return {
    nodeId: exact.nodeId,
    baseBranch: exact.baseBranch,
    baseSha: exact.baseSha,
    ref: "tanren/integration",
    purpose: "merge_batch",
    members: [...exact.members],
    memberKey: exact.memberSetHash,
    gateConfigHash: exact.gateConfigHash,
    policyVersion: exact.policyVersion,
    affectedFingerprint: "",
    headSha: exact.headSha,
    treeHash: exact.treeHash,
    status: "ready",
  };
}

function buildAuthority() {
  const exact = binding();
  const value = envelope(exact);
  const state: RevalidationState = {
    node: persistedNode(exact),
    gateProofValid: true,
    refs: new Map([
      ["main", exact.baseSha],
      ...exact.members.map((member) => [member.branch, member.headSha] as const),
    ]),
  };
  const findByMemberKey = vi.fn<PgIntegrationNodeModel["findByMemberKey"]>(async () => state.node);
  const landAuthorizedIntegration = vi.fn<CodeHost["landAuthorizedIntegration"]>(async () => {
    throw new Error("host CAS must not run for a stale authorization");
  });
  const host = {
    fetchRef: vi.fn<CodeHost["fetchRef"]>(async ({ remoteBranch }) => state.refs.get(remoteBranch)),
    landAuthorizedIntegration,
  } as unknown as CodeHost;
  const revalidator = new PgExactBatchBindingRevalidator({
    orgId: "org-mq16",
    binding: exact,
    envelope: value,
    host,
    repo: value.target.repo,
    intoMain: value.target.intoMain,
    nodes: { findByMemberKey } as unknown as PgIntegrationNodeModel,
    verifyGateProof: async () => state.gateProofValid,
    readDecisionSignals: async () => ({ gateVerdict: "passed", mergeability: "clean", conflicts: "resolved" }),
  });
  const store = {
    persistAuthorizedDecision: vi.fn<AuthorityLandStore["persistAuthorizedDecision"]>(async () => ({
      effectIntentId: "intent-mq16",
    })),
    recordLandReceipt: vi.fn<AuthorityLandStore["recordLandReceipt"]>(async () => ({ auditId: "audit-mq16" })),
  } satisfies AuthorityLandStore;
  return {
    authority: new MergeAuthorityV2Impl(host, revalidator, store),
    exact,
    value,
    state,
    findByMemberKey,
    landAuthorizedIntegration,
    store,
  };
}

describe("MergeAuthorityV2 land-time exact binding revalidation", () => {
  const staleCases: ReadonlyArray<{
    readonly name: string;
    readonly makeStale: (state: RevalidationState) => void;
  }> = [
    {
      name: "the evaluated integration node was deleted",
      makeStale: (state) => {
        state.node = undefined;
      },
    },
    {
      name: "the evaluated integration node is no longer ready",
      makeStale: (state) => {
        state.node = state.node === undefined ? undefined : { ...state.node, status: "failed" };
      },
    },
    {
      name: "the sealed V2 gate-proof bundle was deleted after authorization",
      makeStale: (state) => {
        state.gateProofValid = false;
      },
    },
    {
      name: "a member branch advanced while main remained at the expected SHA",
      makeStale: (state) => {
        state.refs.set("feature/a", "member-a-advanced");
      },
    },
  ];

  for (const staleCase of staleCases) {
    it(`fails closed before host CAS when ${staleCase.name}`, async () => {
      const harness = buildAuthority();
      const authorization = await harness.authority.authorizeLand(allClear(harness.value), harness.value);
      expect(authorization.decision).toBe("authorized");

      staleCase.makeStale(harness.state);
      expect(harness.state.refs.get("main")).toBe(harness.exact.baseSha);

      await expect(harness.authority.land(authorization)).resolves.toMatchObject({ kind: "revalidation_failed" });
      expect(harness.landAuthorizedIntegration).not.toHaveBeenCalled();
      expect(harness.findByMemberKey).toHaveBeenCalledTimes(2);
      expect(harness.store.persistAuthorizedDecision).toHaveBeenCalledTimes(1);
      expect(harness.store.recordLandReceipt).not.toHaveBeenCalled();
    });
  }

  it("still lands a fresh fully valid binding after revalidating it at land time", async () => {
    const harness = buildAuthority();
    harness.landAuthorizedIntegration.mockResolvedValue({ mainSha: harness.exact.headSha });
    const authorization = await harness.authority.authorizeLand(allClear(harness.value), harness.value);

    await expect(harness.authority.land(authorization)).resolves.toEqual({
      kind: "landed",
      mainSha: harness.exact.headSha,
      auditId: "audit-mq16",
    });
    expect(harness.landAuthorizedIntegration).toHaveBeenCalledOnce();
    expect(harness.findByMemberKey).toHaveBeenCalledTimes(2);
    expect(harness.store.recordLandReceipt).toHaveBeenCalledOnce();
  });

  it("returns a completed idempotent land before attempting land-time revalidation", async () => {
    const harness = buildAuthority();
    const authorization = await harness.authority.authorizeLand(allClear(harness.value), harness.value);
    harness.state.node = undefined;
    harness.store.persistAuthorizedDecision.mockResolvedValue({
      effectIntentId: "intent-mq16",
      completed: { mainSha: "already-landed", auditId: "already-recorded" },
    });

    await expect(harness.authority.land(authorization)).resolves.toEqual({
      kind: "landed",
      mainSha: "already-landed",
      auditId: "already-recorded",
    });
    expect(harness.findByMemberKey).toHaveBeenCalledOnce();
    expect(harness.landAuthorizedIntegration).not.toHaveBeenCalled();
  });
});
