import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import type { BatchAuthorityBinding } from "../../src/engine/contracts/batchMergeCoordinator.js";
import { parseDigest } from "../../src/engine/contracts/cas.js";
import type { LandBindingEnvelope } from "../../src/engine/contracts/mergeAuthority.js";
import { PgIntegrationNodeModel } from "../../src/engine/dag/integrationNodesPg.js";
import { PgEventStore } from "../../src/engine/eventStore.js";
import { buildBatchGateProofEvidence } from "./legacyBatchGateEvidence.js";
import { batchArtifactDigest, batchProofRoot } from "../../src/engine/merge/multiMemberAuthorityTypes.js";
import { activeQuarantineVersion } from "../../src/engine/workflow/ciQuarantine.js";
import { memberKey, proofReuseKey } from "./mq2BatchAuthority.js";

export interface Mq2TenantFixture {
  readonly binding: BatchAuthorityBinding;
  readonly envelope: LandBindingEnvelope;
  readonly proofEvidence: unknown;
}

export async function seedMq2Tenant(input: {
  owner: Pool;
  orgId: string;
  projectId: string;
  label: string;
  evaluationId: string;
}): Promise<Mq2TenantFixture> {
  const { evaluationId, label, orgId, owner, projectId } = input;
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, $2, $3)`,
    [projectId, `https://example.com/${projectId}.git`, orgId],
  );
  await runWithOrgScope(owner, orgId, async (client) => {
    await new PgEventStore(client).append({
      projectId,
      orgId,
      eventType: "merge.signal.classified",
      payload: {
        missionNodeId: "mq-1",
        evaluationId,
        groupId: `mqgrp_${"b".repeat(64)}`,
        memberIds: [label],
        findingIds: [`finding-${label}`],
        signalVersion: "merge_signal.v1",
        classification: "deterministic_policy",
        reasonCode: "audit_policy",
        retryability: "non_retryable",
        wakeKey: null,
        disposition: "member_repair",
      },
    });
  });
  const members = [
    { specId: `${label}1`, runId: `run-${label}1`, branch: `feature/${label}1`, headSha: `sha-${label}1` },
    { specId: `${label}2`, runId: `run-${label}2`, branch: `feature/${label}2`, headSha: `sha-${label}2` },
  ];
  // gv-17: dual-written members require same-org spec/run FKs.
  for (const member of members) {
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
      [member.specId, projectId, orgId],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', $5, 'running')`,
      [member.runId, member.specId, projectId, orgId, member.branch],
    );
  }
  const baseSha = `base-${label}`;
  const headSha = `batch-${label}`;
  const treeHash = `tree-${label}`;
  const key = memberKey(
    baseSha,
    members.map((member) => member.headSha),
  );
  const keyInput = {
    memberKey: key,
    gateConfigHash: "gate-v1",
    policyVersion: "policy-v1",
    runnerImage: "runner@sha256:abc",
    appEnvHash: "env-v1",
    quarantineVersion: activeQuarantineVersion({ checkNames: new Set(), testIds: [] }),
  };
  const nodes = new PgIntegrationNodeModel(owner);
  const nodeId = await nodes.upsertNode({
    projectId,
    orgId,
    baseBranch: "main",
    baseSha,
    ref: `tanren-local-${label}`,
    purpose: "merge_batch",
    members,
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
    headSha,
    treeHash,
    status: "ready",
  });
  const proofEvidence = buildBatchGateProofEvidence({
    nodeId,
    headSha,
    treeHash,
    memberSetHash: key,
    keyInput,
    passed: true,
  });
  const proofKey = await nodes.recordProof({
    orgId,
    projectId,
    nodeId,
    keyInput,
    verdict: "passed",
    evidence: proofEvidence,
  });
  if (proofKey !== proofReuseKey(keyInput)) throw new Error("proof key must match its canonical input");
  await runWithOrgScope(owner, orgId, (client) =>
    client.query(
      `INSERT INTO authority_decisions
         (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
          artifact_digest, proof_root, member_set_hash, policy_version, decision)
       VALUES ($1,$2,$3,$4,'integration_node',$5,$6,$7,$8,$9,$10,'authorized')`,
      [
        orgId,
        projectId,
        `decision-${label}`,
        nodeId,
        headSha,
        baseSha,
        artifactDigest(headSha, treeHash),
        `sha256:${proofKey}`,
        key,
        keyInput.policyVersion,
      ],
    ),
  );
  const binding: BatchAuthorityBinding = {
    nodeId,
    baseBranch: "main",
    baseSha,
    headSha,
    treeHash,
    members,
    memberSetHash: key,
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
    proof: {
      verdict: "passed",
      keyInput,
      gateProofBundleId: `gate_proof_bundle:${nodeId}`,
      proofBundleDigest: parseDigest(`sha256:${"a".repeat(64)}`),
      proofRoot: parseDigest(`sha256:${"b".repeat(64)}`),
    },
  };
  const envelope: LandBindingEnvelope = {
    subject: { kind: "integration_node", id: nodeId },
    members: members.map((member) => ({ ...member, disposition: "admit" })),
    headSha,
    expectedMainSha: baseSha,
    artifactDigest: batchArtifactDigest(binding),
    proofRoot: batchProofRoot(binding),
    memberSetHash: key,
    policyVersion: keyInput.policyVersion,
    target: { repo: { owner: "cat-cave", name: "tanren" }, intoMain: "main" },
  };
  return { binding, envelope, proofEvidence };
}

function artifactDigest(headSha: string, treeHash: string): string {
  return `sha256:${createHash("sha256")
    .update("tanren:merge-batch-artifact:v1\0")
    .update(headSha)
    .update("\0")
    .update(treeHash)
    .digest("hex")}`;
}
