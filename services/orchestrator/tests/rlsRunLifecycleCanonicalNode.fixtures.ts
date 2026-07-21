import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { runWithOrgScope } from "@tanren/db";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import type { PgIntegrationNodeModel } from "../src/engine/dag/integrationNodesPg.js";
import { PgGateProofBundleSealer } from "../src/engine/merge/gateProofBundleSealPg.js";
import { buildCoverageAuthorityReadyNodeMaterializer } from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";
import { activeQuarantineVersion, loadActiveQuarantine } from "../src/engine/workflow/ciQuarantine.js";
import { buildMultiMemberEnvelope } from "../src/engine/merge/multiMemberAuthorityPgState.js";
import { TestProofSubstrate } from "./helpers/mergeTrainTestSubstrate.js";
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
  const quarantineVersion = await runWithOrgScope(input.pool, input.orgId, async (client) =>
    activeQuarantineVersion(await loadActiveQuarantine(client, input.entry.projectId)),
  );
  const keyInput = {
    memberKey: memberSetHash,
    gateConfigHash: "gc",
    policyVersion: "1",
    runnerImage: "runner:v0",
    appEnvHash: "lifecycle-test",
    quarantineVersion,
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
  const proofSubstrate = new TestProofSubstrate(input.pool, new PgCasByteStore(input.pool));
  const bundle = await new PgGateProofBundleSealer(input.pool, {
    proofSubstrate,
    cas: new PgCasByteStore(input.pool),
  }).seal({
    orgId: input.orgId,
    projectId: input.entry.projectId,
    nodeId,
    baseSha: LIFECYCLE_BASE_SHA,
    headSha: input.headSha,
    treeHash: LIFECYCLE_TREE_SHA,
    memberSetHash,
    members: [member],
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
    proofKeyInput: keyInput,
    nativeCi: {
      gateConfigHash: keyInput.gateConfigHash,
      tiers: ["pre_merge"],
      steps: [{ name: "lifecycle-native-ci", tier: "pre_merge", passed: true }],
      junit: { total: 1, failures: 0, skipped: 0 },
      verdict: "passed",
    },
  });
  const binding = {
    nodeId,
    baseBranch: "main",
    baseSha: LIFECYCLE_BASE_SHA,
    headSha: input.headSha,
    treeHash: LIFECYCLE_TREE_SHA,
    members: [member],
    memberSetHash,
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
    proof: {
      verdict: "passed" as const,
      keyInput,
      gateProofBundleId: bundle.gateProofBundleId,
      proofBundleDigest: bundle.proofBundleDigest,
      proofRoot: bundle.proofRoot,
    },
  };
  return { binding, proofSubstrate, envelope: buildMultiMemberEnvelope(binding, input.repo, "main") };
}
