// cspell:ignore sfind sorigin venv vrun iloop adec
// Shared driver for the bh-14a proof-seal RLS proof: it seeds a complete
// issue-loop evidence graph, drives the REAL ResolutionDagWalker production
// stage, and closes the source through the REAL source-sync worker — keeping the
// heavy engine imports out of the test file (import/max-dependencies).
import { runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ResolutionDagWalker } from "../../src/engine/dag/resolutionDagWalker.js";
import { buildResolutionAuthority } from "../../src/engine/governance/resolutionAuthority.js";
import type { IssueSourceAdapter } from "../../src/engine/forge/issueSourceAdapter.js";
import { processSourceSync } from "../../src/engine/forge/sourceSyncWorker.js";
import { ResolutionJobStore } from "../../src/engine/repositories/resolutionJobs.js";
import { SourceSyncOutboxStore } from "../../src/engine/repositories/sourceSyncOutbox.js";
import { ProductionSymptomStage } from "../../src/engine/verification/resolutionStages/productionSymptomStage.js";
import { PgRepairRouter } from "../../src/engine/workflow/repairRouting.js";
import { stubBehaviorContextLoader } from "./stubBehaviorContextLoader.js";

export const PROOF_IDS = {
  org: "org_resolution_proof",
  otherOrg: "org_resolution_proof_other",
  project: "project_resolution_proof",
  loop: "iloop_resolution_proof",
  node: "inode_resolution_proof",
  environment: "venv_resolution_proof",
  release: "release_resolution_proof",
  contract: "contract_proof",
  mergeSha: "a".repeat(40),
} as const;

export function proofDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function contract() {
  return {
    baselineRequired: true,
    expectedCorrectedObservation: { body: { status: "fixed" }, status: 200 },
    expectedFailingObservation: { body: { status: "still_broken" }, status: 200 },
    issueLoopId: PROOF_IDS.loop,
    proofPolicy: "active_causal",
    sourceRevision: "source-revision-a",
    target: { url: "https://contract.example/symptom" },
    version: 1,
  };
}

export async function seedProofFixture(owner: Pool, releaseUrl: string): Promise<{ artifactDigest: string }> {
  const artifactDigest = proofDigest("proof-artifact");
  const { org, otherOrg, project, loop, node, environment, release, contract: contractId, mergeSha } = PROOF_IDS;
  for (const id of [org, otherOrg]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [id],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/proof.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [project, org],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, config)
     VALUES ('source_proof', $1, $2, 'issues', 'source', '{"owner":"proof","repo":"fixture","labels":[]}'::jsonb)`,
    [org, project],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint, severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, 'source_proof', 'proof-issue', 1, 'proof-fingerprint', 'high', 'verifying', 'active_causal', 1, now())`,
    [org, loop, project],
  );
  await owner.query(
    `INSERT INTO source_findings
       (org_id, id, project_id, issue_loop_id, source_id, provider_object_id, provider_revision,
        status, title, fingerprint, observed_at)
     VALUES ($1, 'sfind_proof', $2, $3, 'source_proof', 'proof-issue', 'rev-1',
             'open', 'proof symptom', 'proof-fingerprint', now())`,
    [org, project, loop],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, issue_loop_id, org_id, kind, title, status, agent_kind, cli)
     VALUES ('task_proof_triage', NULL, $1, $2, 'triage', 'proof triage', 'done', 'answerer', 'fixture')`,
    [loop, org],
  );
  await owner.query(
    `INSERT INTO specs
       (spec_id, project_id, org_id, title, description, status, origin_issue_loop_id, origin_run_id)
     VALUES ('spec_proof_primary', $1, $2, 'Resolve proof symptom', 'primary fix',
             'merged', $3, 'run_proof_primary')`,
    [project, org, loop],
  );
  await owner.query(
    `INSERT INTO spec_origins
       (org_id, project_id, id, spec_id, issue_loop_id, triage_task_id, attempt_number, role, ordinal)
     VALUES ($1, $2, 'sorigin_proof_primary', 'spec_proof_primary', $3,
             'task_proof_triage', 1, 'primary_fix', 0)`,
    [org, project, loop],
  );
  await owner.query(
    `INSERT INTO spec_origin_findings (org_id, spec_id, source_finding_id)
     VALUES ($1, 'spec_proof_primary', 'sfind_proof')`,
    [org],
  );
  await owner.query(
    `INSERT INTO symptom_contracts
       (org_id, project_id, id, issue_loop_id, schema_version, contract_json, canonical_hash,
        proof_policy, target, source_revision, state)
     VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, 'active_causal', $7::jsonb, $8, 'validated')`,
    [
      org,
      project,
      contractId,
      loop,
      JSON.stringify(contract()),
      proofDigest(JSON.stringify(contract())),
      JSON.stringify(contract().target),
      contract().sourceRevision,
    ],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/proof', 'merge_batch', '[]'::jsonb, 'member-proof', $4, 'tree-proof', 'ready')`,
    [node, project, org, mergeSha],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [org, artifactDigest],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'production', 'proof-fingerprint', 'proof-lease', 'ready')`,
    [org, environment, project, node, artifactDigest],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', 'proof-app', 'production', 'proof-deploy', $4, $5, NULL, $6, $7, 'live')`,
    [org, release, project, mergeSha, artifactDigest, node, releaseUrl],
  );
  await seedEvidence(owner, artifactDigest, contractId);
  return { artifactDigest };
}

async function seedEvidence(owner: Pool, artifactDigest: string, contractId: string): Promise<void> {
  const { org, project, loop, environment, mergeSha, node } = PROOF_IDS;
  for (const [id, stage, classification] of [
    ["rjob_proof_baseline", "baseline", "product_failure"],
    ["rjob_proof_counterfactual", "counterfactual", "product_resolved"],
  ]) {
    await owner.query(
      `INSERT INTO resolution_jobs (org_id, project_id, id, issue_loop_id, contract_id, stage, state, idempotency_key, attempt)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $3, 1)`,
      [org, project, id, loop, contractId, stage],
    );
    await owner.query(
      `INSERT INTO behavior_verification_runs
         (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
          runtime_behavior_context_hash, artifact_digest, status, policy, stage, resolution_job_id, classification)
       VALUES ($1, $2, $3, 'post_merge_production', $4, $5, 'tree-proof', $6, $7, $8, 'completed', $9::jsonb, $10, $11, $12)`,
      [
        org,
        `vrun_${stage}`,
        project,
        environment,
        mergeSha,
        proofDigest(`plan-${stage}`),
        proofDigest(`context-${stage}`),
        artifactDigest,
        JSON.stringify({ proofPolicy: "active_causal" }),
        stage,
        id,
        classification,
      ],
    );
  }
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha, artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1, $2, 'adec_proof', $3, 'integration_node', $4, $4, $5, $6, 'member-proof', 'policy-proof', 'authorized')`,
    [org, project, node, mergeSha, artifactDigest, proofDigest("proof-root")],
  );
  await owner.query(
    `INSERT INTO authority_effect_intents
       (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha, expected_main_sha, idempotency_key)
     VALUES ($1, $2, 'aei_proof', 'adec_proof', $3, 'main', $4, $4, 'proof-intent')`,
    [org, project, node, mergeSha],
  );
  await owner.query(
    `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
     VALUES ($1, $2, 'alr_proof', 'aei_proof', $3, 'audit_proof')`,
    [org, project, mergeSha],
  );
}

/** Enqueue + drive a production replay through the REAL walker + authority. */
export async function walkProduction(app: Pool, id: string): Promise<void> {
  const { org, project, loop, release, contract: contractId } = PROOF_IDS;
  const jobs = new ResolutionJobStore(app);
  await jobs.enqueue({
    orgId: org,
    projectId: project,
    id,
    issueLoopId: loop,
    contractId,
    releaseInstanceId: release,
    stage: "production",
    idempotencyKey: id,
  });
  const walker = new ResolutionDagWalker({
    behaviorContextLoader: stubBehaviorContextLoader(),
    store: jobs,
    orgIds: async () => [org],
    stages: new Map([["production", new ProductionSymptomStage({ pool: app })]]),
    authority: buildResolutionAuthority(app),
    repairRouter: new PgRepairRouter(app),
    leaseOwner: `walker-${id}`,
  });
  await walker.tick();
}

const closeAdapter: IssueSourceAdapter = {
  provider: "test",
  async ingest() {
    throw new Error("ingest is not used by proof source-sync");
  },
  async sync() {
    return { providerRevision: "proof-close-revision" };
  },
  async readback() {
    return { providerRevision: "proof-close-revision", desiredState: "closed" };
  },
};

/** Drive the enqueued close through the REAL source-sync worker to verified_closed. */
export async function drainSourceClose(app: Pool): Promise<boolean> {
  const { org, loop } = PROOF_IDS;
  const runnable = await runWithOrgScope(app, org, (client) => SourceSyncOutboxStore.listRunnable(client, 20));
  const closeRow = runnable.find((row) => row.issueLoopId === loop && row.operation === "close");
  if (closeRow === undefined) throw new Error("no close outbox row was enqueued by the authorized decision");
  const result = await processSourceSync(
    { pool: app, adapters: new Map([["issues", closeAdapter]]), workerId: "proof-source-sync" },
    closeRow,
  );
  return result?.verified === true;
}
