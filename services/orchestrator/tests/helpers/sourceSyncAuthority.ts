// cspell:ignore vassert
import { runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  PgResolutionAuthorityDecisionStore,
  ResolutionAuthority,
} from "../../src/engine/governance/resolutionAuthority.js";
import { SymptomContractStore } from "../../src/engine/repositories/symptomContracts.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function authorizeSourceSync(
  pool: Pool,
  input: { orgId: string; projectId: string; issueLoopId: string },
): Promise<{ id: string; created: boolean }> {
  const contract = await new SymptomContractStore(pool).create({
    orgId: input.orgId,
    projectId: input.projectId,
    contract: {
      version: 1,
      issueLoopId: input.issueLoopId,
      target: { url: "https://source-sync.example/symptom" },
      expectedFailingObservation: { status: 200, body: { status: "still_broken" } },
      expectedCorrectedObservation: { status: 200, body: { status: "fixed" } },
      proofPolicy: "active_causal",
      sourceRevision: `source-sync-${input.issueLoopId}`,
      baselineRequired: true,
    },
  });
  const jobId = `rjob_source_sync_${input.issueLoopId}`;
  await runWithOrgScope(pool, input.orgId, async (client) => {
    await client.query(
      `INSERT INTO resolution_jobs
         (org_id, project_id, id, issue_loop_id, contract_id, stage, state, idempotency_key, attempt)
       VALUES ($1, $2, $3, $4, $5, 'production', 'completed', $3, 1)`,
      [input.orgId, input.projectId, jobId, input.issueLoopId, contract.id],
    );
  });
  const sha = "a".repeat(40);
  const artifactDigest = digest(`artifact-${input.issueLoopId}`);
  const run = { verificationRunId: `vrun_source_sync_${input.issueLoopId}`, artifactDigest, mergeSha: sha };
  const authority = new ResolutionAuthority(
    {
      async snapshot() {
        return {
          version: "tanren-resolution-evidence.v1" as const,
          orgId: input.orgId,
          projectId: input.projectId,
          resolutionJobId: jobId,
          issueLoopId: input.issueLoopId,
          contract: {
            id: contract.id,
            hash: digest(`contract-${input.issueLoopId}`),
            sourceRevision: `source-sync-${input.issueLoopId}`,
          },
          baseline: { ...run, verificationRunId: `vrun_baseline_${input.issueLoopId}` },
          counterfactual: { ...run, verificationRunId: `vrun_counterfactual_${input.issueLoopId}` },
          soak: null,
          merge: { authorityAuditId: `audit_${input.issueLoopId}`, sha },
          deployment: { releaseInstanceId: null, artifactDigest, mergeSha: sha },
          production: {
            ...run,
            outcome: "passed" as const,
            classification: "product_resolved" as const,
            assertionOutcomes: [{ id: `vassert_${input.issueLoopId}`, outcome: "passed" as const }],
          },
          proofGrade: "active_causal" as const,
          resolutionPolicy: "active_causal" as const,
        };
      },
    },
    new PgResolutionAuthorityDecisionStore(pool),
  );
  const decision = await authority.authorize({ orgId: input.orgId, resolutionJobId: jobId });
  if (decision.decision !== "authorized") throw new Error("source-sync fixture did not receive an authorized decision");
  const retried = await authority.authorize({ orgId: input.orgId, resolutionJobId: jobId });
  if (retried.id !== decision.id || retried.created) throw new Error("source-sync authority retry was not idempotent");
  return { id: decision.id, created: decision.created };
}
