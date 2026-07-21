import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { memberKey, proofReuseKey } from "../src/engine/contracts/integrationNodes.js";
import { PgIntegrationNodeModel } from "../src/engine/dag/integrationNodesPg.js";
import { buildCoverageAuthorityReadyNodeMaterializer } from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";
import { activeQuarantineVersion } from "../src/engine/workflow/ciQuarantine.js";
import { buildBatchGateProofEvidence } from "../src/engine/merge/multiMemberAuthorityEvidence.js";
import { buildMultiMemberEnvelope } from "../src/engine/merge/multiMemberAuthorityPgState.js";
import { LIFECYCLE_BASE_SHA, LIFECYCLE_TREE_SHA } from "./rlsRunLifecycleAuthority.fixtures.js";

/** Materialize the exact, persisted one-member node/proof the canonical drive requires. */
export async function materializeLifecycleCanonicalNode(input: {
  pool: ConstructorParameters<typeof PgIntegrationNodeModel>[0];
  orgId: string;
  entry: MergeQueueEntry;
  repo: { owner: string; name: string };
  headBranch: string;
  headSha: string;
  ssh: CommandSubstrate;
  target: RunnerHandle;
}) {
  const member = {
    specId: input.entry.specId,
    runId: input.entry.runId,
    branch: input.headBranch,
    headSha: input.headSha,
  };
  const memberSetHash = memberKey(LIFECYCLE_BASE_SHA, [member.headSha]);
  const keyInput = {
    memberKey: memberSetHash,
    gateConfigHash: "gc",
    policyVersion: "1",
    runnerImage: "runner:v0",
    appEnvHash: "lifecycle-test",
    quarantineVersion: activeQuarantineVersion({ checkNames: new Set(), testIds: [] }),
  };
  const nodeId = await buildCoverageAuthorityReadyNodeMaterializer(input.pool)({
    orgId: input.orgId,
    projectId: input.entry.projectId,
    baseBranch: "main",
    baseSha: LIFECYCLE_BASE_SHA,
    ref: "tanren-local-batch-lifecycle",
    purpose: "merge_batch",
    members: [member],
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
    headSha: input.headSha,
    treeHash: LIFECYCLE_TREE_SHA,
    workspace: { ssh: input.ssh, target: input.target, workspacePath: "/workspace/lifecycle" },
  });
  const binding = {
    nodeId,
    baseBranch: "main",
    baseSha: LIFECYCLE_BASE_SHA,
    headSha: input.headSha,
    treeHash: LIFECYCLE_TREE_SHA,
    members: [member],
    memberSetHash,
    policyVersion: keyInput.policyVersion,
    proof: { verdict: "passed" as const, proofReuseKey: proofReuseKey(keyInput), keyInput },
  };
  await new PgIntegrationNodeModel(input.pool).recordProof({
    orgId: input.orgId,
    projectId: input.entry.projectId,
    nodeId,
    keyInput,
    verdict: "passed",
    evidence: buildBatchGateProofEvidence({
      nodeId,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
      memberSetHash,
      keyInput,
      passed: true,
    }),
  });
  return { binding, envelope: buildMultiMemberEnvelope(binding, input.repo, "main") };
}
