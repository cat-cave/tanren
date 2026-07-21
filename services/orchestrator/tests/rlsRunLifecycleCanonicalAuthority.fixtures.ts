import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import { serviceAuditActor } from "../src/engine/events/schemas/audit.js";
import { PgLandGroupStore } from "../src/engine/merge/landGroupStore.js";
import { PgGateProofBundleVerifier } from "../src/engine/merge/gateProofBundleVerifyPg.js";
import { buildPgExactBatchAuthority } from "../src/engine/merge/multiMemberAuthorityPgAuthority.js";
import { evaluateMultiMemberAuthority } from "../src/engine/merge/multiMemberAuthorityEvaluator.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { lifecycleAuthorityHost } from "./rlsRunLifecycleAuthority.fixtures.js";
import { materializeLifecycleCanonicalNode } from "./rlsRunLifecycleCanonicalNode.fixtures.js";

type CanonicalNodeInput = Parameters<typeof materializeLifecycleCanonicalNode>[0];

/** Build and authorize the actual one-member V2/group authority over a persisted node. */
export async function buildLifecycleCanonicalAuthority(input: CanonicalNodeInput) {
  const { binding, envelope, proofSubstrate } = await materializeLifecycleCanonicalNode(input);
  const taskId = await mergeTaskId(input.pool, input.orgId, input.entry.runId);
  // The production in-process coordinator gives its direct writer this proxy so
  // queue event appends acquire a short RLS scope for every database operation.
  const writer = new DirectRunStateWriter(orgScopingPool(input.pool));
  const host = lifecycleAuthorityHost({ repo: input.repo, headBranch: input.headBranch, headSha: input.headSha });
  const authority = buildPgExactBatchAuthority({
    pool: input.pool,
    orgId: input.orgId,
    binding,
    envelope,
    host,
    repo: input.repo,
    intoMain: "main",
    context: {
      orgId: input.orgId,
      runId: input.entry.runId,
      specId: input.entry.specId,
      projectId: input.entry.projectId,
      taskId,
      prUrl: input.entry.prUrl,
      prNumber: input.entry.prNumber,
      integration: "native_queue",
      auditEnvelope: { policyVersion: 1, initiatingActor: serviceAuditActor },
    },
    runStateWriter: writer,
    gateProofs: new PgGateProofBundleVerifier(input.pool, proofSubstrate),
    landStore: new PgLandGroupStore({
      pool: input.pool,
      orgId: input.orgId,
      projectId: input.entry.projectId,
      groupId: `lifecycle-${input.entry.queueId}`,
      partitionId: input.entry.partitionId ?? "default",
      policyVersion: 1,
      members: [
        {
          ...binding.members[0]!,
          projectId: input.entry.projectId,
          taskId,
          prUrl: input.entry.prUrl,
          prNumber: input.entry.prNumber,
        },
      ],
    }),
  });
  const evaluation = await evaluateMultiMemberAuthority({
    binding,
    entries: [input.entry],
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
  if (evaluation.kind !== "authorized_subset") {
    throw new Error(`canonical lifecycle node was not authorized: ${evaluation.kind}`);
  }
  return { authority, binding, evaluation, writer, host };
}

async function mergeTaskId(pool: Pool, orgId: string, runId: string): Promise<string> {
  const result = await runWithOrgScope(pool, orgId, (client) =>
    client.query<{ task_id: string }>(
      "SELECT task_id FROM tasks WHERE org_id = $1 AND run_id = $2 AND kind = 'merge' ORDER BY task_id LIMIT 1",
      [orgId, runId],
    ),
  );
  const taskId = result.rows[0]?.task_id;
  if (taskId === undefined) throw new Error(`lifecycle run ${runId} has no merge task`);
  return taskId;
}
