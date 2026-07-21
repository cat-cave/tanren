import type { Pool } from "pg";
import type { BatchAuthorityBinding } from "../../src/engine/contracts/batchMergeCoordinator.js";
import type { GateProofBundleVerifier } from "../../src/engine/merge/gateProofBundleTypes.js";
import { buildMultiMemberEnvelope } from "../../src/engine/merge/multiMemberAuthorityPgState.js";
import { PgLandGroupStore } from "../../src/engine/merge/landGroupStore.js";
import { buildPgExactBatchAuthority } from "../../src/engine/merge/multiMemberAuthorityPgAuthority.js";
import { evaluateMultiMemberAuthority } from "../../src/engine/merge/multiMemberAuthorityEvaluator.js";
import { serviceAuditActor } from "../../src/engine/events/schemas/audit.js";
import { orgScopingPool } from "../../src/engine/data/orgScopedDb.js";
import { DirectRunStateWriter } from "../../src/engine/worker/directRunStateWriter.js";
import { InMemoryCodeHost } from "../conformance/fakes/inMemoryCodeHost.js";
import { reuseV2Entry } from "./gateProofBundleReuseV2Drive.fixtures.js";

const ORG = "org_gate_reuse_v2";
const PROJECT = "project_gate_reuse_v2";
const REPO = { owner: "tanren", name: "gate-reuse-v2" };
const MEMBER = { specId: "spec_reuse_a", runId: "run_reuse_a", branch: "reuse-a", headSha: "2".repeat(40) };

class CountingCodeHost extends InMemoryCodeHost {
  readonly landCalls: Parameters<InMemoryCodeHost["landAuthorizedIntegration"]>[0][] = [];

  override async landAuthorizedIntegration(input: Parameters<InMemoryCodeHost["landAuthorizedIntegration"]>[0]) {
    this.landCalls.push(input);
    return super.landAuthorizedIntegration(input);
  }
}

/** Lands one real exact V2 authority and asserts the host CAS used that fresh coordinate. */
export async function landReuseV2Binding(
  pool: Pool,
  binding: BatchAuthorityBinding,
  gateProofs: GateProofBundleVerifier,
): Promise<void> {
  const host = new CountingCodeHost();
  host.seed(REPO, "main", binding.baseSha);
  for (const member of binding.members) {
    await host.pushRef({ repo: REPO, localRef: member.branch, remoteBranch: member.branch, sha: member.headSha });
  }
  const envelope = buildMultiMemberEnvelope(binding, REPO, "main");
  const authority = buildPgExactBatchAuthority({
    pool,
    orgId: ORG,
    binding,
    envelope,
    host,
    repo: REPO,
    intoMain: "main",
    context: {
      orgId: ORG,
      projectId: PROJECT,
      runId: MEMBER.runId,
      specId: MEMBER.specId,
      taskId: "task_merge_reuse_a",
      prUrl: "https://example.test/spec_reuse_a",
      prNumber: 1,
      integration: "native_queue",
      auditEnvelope: { policyVersion: 1, initiatingActor: serviceAuditActor },
    },
    runStateWriter: new DirectRunStateWriter(orgScopingPool(pool)),
    gateProofs,
    landStore: new PgLandGroupStore({
      pool,
      orgId: ORG,
      projectId: PROJECT,
      groupId: "gate-reuse-v2-land",
      partitionId: "default",
      policyVersion: 1,
      members: [
        {
          ...MEMBER,
          projectId: PROJECT,
          taskId: "task_merge_reuse_a",
          prUrl: "https://example.test/spec_reuse_a",
          prNumber: 1,
        },
      ],
    }),
  });
  const evaluation = await evaluateMultiMemberAuthority({
    binding,
    entries: [reuseV2Entry(MEMBER.specId, MEMBER.runId)],
    decisionInput: {
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
    },
    envelope,
    authority,
    memberFindings: [],
  });
  if (evaluation.kind !== "authorized_subset")
    throw new Error(`fresh V2 binding was not authorized: ${evaluation.kind}`);
  await authority.land(evaluation.authorization);
  if (host.landCalls.length !== 1) throw new Error("fresh V2 authority did not make exactly one host CAS");
  const call = host.landCalls[0];
  if (
    call?.expectedMainSha !== binding.baseSha ||
    call.authorizedSha !== binding.headSha ||
    call.idempotencyKey !== "land-group-gate-reuse-v2-land"
  ) {
    throw new Error("host CAS did not use the fresh V2 authority coordinate");
  }
}
