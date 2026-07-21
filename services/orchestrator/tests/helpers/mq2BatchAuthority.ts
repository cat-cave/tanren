// cspell:ignore mqeval mqgrp
import { createHash } from "node:crypto";
import type pg from "pg";
import type { BatchAuthorityBinding } from "../../src/engine/contracts/batchMergeCoordinator.js";
import { memberKey, proofReuseKey } from "../../src/engine/contracts/integrationNodes.js";
import type { MergeQueueEntry } from "../../src/engine/contracts/mergeCoordinator.js";
import type { MergeSignalClassificationV1 } from "../../src/engine/merge/authoritySignalClassification.js";
import { authorityDerivedId } from "../../src/engine/merge/authoritySignalIdentity.js";
import {
  buildBatchGateProofEvidence,
  MultiMemberAuthorityInfrastructureFault,
} from "../../src/engine/merge/multiMemberAuthorityEvidence.js";
import { activeQuarantineVersion } from "../../src/engine/workflow/ciQuarantine.js";
import type { BatchAuthorityEvaluator } from "../../src/engine/merge/multiMemberAuthorityTypes.js";
import {
  batchArtifactDigest,
  batchProofRoot,
  MULTI_MEMBER_AUTHORITY_VERSION,
} from "../../src/engine/merge/multiMemberAuthorityTypes.js";

export type { BatchAuthorityBinding } from "../../src/engine/contracts/batchMergeCoordinator.js";
export type { LandBindingEnvelope } from "../../src/engine/contracts/mergeAuthority.js";
export { memberKey, proofReuseKey };
export { PgIntegrationNodeModel } from "../../src/engine/dag/integrationNodesPg.js";
export {
  loadBatchDecisionEvidence,
  loadCurrentQuarantineVersion,
  loadPersistedBatchDecisionSignals,
} from "../../src/engine/merge/multiMemberAuthorityEvidencePg.js";
export { PgExactBatchBindingRevalidator } from "../../src/engine/merge/multiMemberAuthorityPgAuthority.js";
export {
  activeQuarantineVersion,
  batchArtifactDigest,
  batchProofRoot,
  buildBatchGateProofEvidence,
  MultiMemberAuthorityInfrastructureFault,
};

export const MQ2_ROUTE_PROJECT = "project_tanren";

export interface StoredSignal {
  id: string;
  orgId: string;
  projectId: string;
  ts: Date;
  payload: MergeSignalClassificationV1;
}

export interface StoredDecision {
  decision_id: string;
  created_at: Date;
  node_id: string;
  decision_head_sha: string;
  expected_main_sha: string;
  artifact_digest: string;
  proof_root: string;
  decision_member_set_hash: string;
  decision_policy_version: string;
  base_sha: string;
  node_head_sha: string;
  tree_hash: string;
  members: Array<{ specId: string; runId: string; branch: string; headSha: string }>;
  member_key: string;
  gate_config_hash: string;
  node_policy_version: string;
  proof_reuse_key: string;
  proof_evidence: unknown;
}

export interface StoredBatchNode {
  node_id: string;
  base_sha: string;
  head_sha: string;
  tree_hash: string;
  members: Array<{ specId: string; runId: string; branch: string; headSha: string }>;
  member_key: string;
  gate_config_hash: string;
  policy_version: string;
}

export interface StoredBatchProof extends StoredBatchNode {
  proof_id: string;
  proof_created_at: Date;
  proof_reuse_key: string;
  proof_verdict: string;
  proof_evidence: unknown;
}

export interface StoredQuarantine {
  id: string;
  check_name: string;
  test_id: string | null;
  toggled_sha_count: number;
  observation_count: number;
  evidence: unknown;
  quarantined_at: Date;
}

export interface StoredSpec {
  spec_id: string;
  depends_on: string[];
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export class EvaluationProjectionPool {
  readonly scopeStatements: string[] = [];
  readonly projectionQueries: string[] = [];

  constructor(
    private readonly projectOrg: string | null,
    private readonly signals: ReadonlyArray<StoredSignal>,
    private readonly decisions: ReadonlyArray<StoredDecision>,
    private readonly proofs: ReadonlyArray<StoredBatchProof> = [],
    private readonly nodes: ReadonlyArray<StoredBatchNode> = [],
    private readonly specs: ReadonlyArray<StoredSpec> = [],
    private readonly quarantines: ReadonlyArray<StoredQuarantine> = [],
  ) {}

  asPgPool(): pg.Pool {
    return {
      connect: async () => {
        let scopedOrg: string | undefined;
        return {
          query: async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
            const text = sql.replaceAll(/\s+/gu, " ").trim();
            if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return queryRows([]);
            if (text.startsWith("SET LOCAL app.current_org_id")) {
              this.scopeStatements.push(text);
              scopedOrg = text.match(/= '([^']+)'$/u)?.[1];
              return queryRows([]);
            }
            if (text.startsWith("SELECT org_id FROM projects")) {
              if (this.projectOrg === null || this.projectOrg !== scopedOrg || params[0] !== MQ2_ROUTE_PROJECT) {
                return queryRows([]);
              }
              return queryRows([{ org_id: this.projectOrg }]);
            }
            if (text.startsWith("SELECT role FROM project_members")) return queryRows([]);
            if (text.includes("FROM events") && text.includes("merge.signal.classified")) {
              this.projectionQueries.push(text);
              const visible = this.signals.filter(
                (signal) => signal.orgId === scopedOrg && signal.projectId === params[0] && signal.orgId === params[1],
              );
              const selected = text.includes("payload->>'evaluationId'")
                ? visible.filter((signal) => signal.payload.evaluationId === params[2])
                : visible.slice(0, Number(params[2]));
              return queryRows(
                selected.map((signal) => ({ event_id: signal.id, ts: signal.ts, payload: signal.payload })),
              );
            }
            if (text.includes("FROM authority_decisions d")) {
              this.projectionQueries.push(text);
              return queryRows(text.includes("LIMIT $3") ? this.decisions.slice(0, Number(params[2])) : this.decisions);
            }
            if (text.includes("FROM integration_proofs p")) {
              this.projectionQueries.push(text);
              return queryRows(text.includes("LIMIT $3") ? this.proofs.slice(0, Number(params[2])) : this.proofs);
            }
            if (text.includes("FROM quarantined_tests")) return queryRows(this.quarantines);
            if (text.includes("FROM integration_nodes")) return queryRows(this.nodes);
            if (text.includes("FROM specs")) return queryRows(this.specs);
            throw new Error(`unexpected query: ${text}`);
          },
          release() {},
        };
      },
    } as unknown as pg.Pool;
  }
}

function queryRows(values: Record<string, unknown>[]): QueryResult {
  return { rows: values, rowCount: values.length };
}

export function validDecision(overrides: Partial<StoredDecision> = {}): StoredDecision {
  const members = [
    { specId: "A", runId: "run-a", branch: "feature/a", headSha: "sha-a" },
    { specId: "B", runId: "run-b", branch: "feature/b", headSha: "sha-b" },
  ];
  const baseSha = "sha-main";
  const headSha = "sha-batch";
  const treeHash = "tree-batch";
  const key = memberKey(
    baseSha,
    members.map((member) => member.headSha),
  );
  const gateConfigHash = "gate-v7";
  const policyVersion = "policy-v7";
  const keyInput = {
    memberKey: key,
    gateConfigHash,
    policyVersion,
    runnerImage: "runner@sha256:decision",
    appEnvHash: "env-decision",
    quarantineVersion: activeQuarantineVersion({ checkNames: new Set(), testIds: [] }),
  };
  const proofKey = proofReuseKey(keyInput);
  const nodeId = "inode_batch";
  return {
    decision_id: "decision-inode-batch-sha-batch",
    created_at: new Date("2026-07-15T12:10:00.000Z"),
    node_id: nodeId,
    decision_head_sha: headSha,
    expected_main_sha: baseSha,
    artifact_digest: artifactDigest(headSha, treeHash),
    proof_root: `sha256:${proofKey}`,
    decision_member_set_hash: key,
    decision_policy_version: policyVersion,
    base_sha: baseSha,
    node_head_sha: headSha,
    tree_hash: treeHash,
    members,
    member_key: key,
    gate_config_hash: gateConfigHash,
    node_policy_version: policyVersion,
    proof_reuse_key: proofKey,
    proof_evidence: buildBatchGateProofEvidence({
      nodeId,
      headSha,
      treeHash,
      memberSetHash: key,
      keyInput,
      passed: true,
    }),
    ...overrides,
  };
}

export function validBatchNode(): StoredBatchNode {
  const members = [
    { specId: "A", runId: "run-a", branch: "feature/a", headSha: "sha-a" },
    { specId: "B", runId: "run-b", branch: "feature/b", headSha: "sha-b" },
    { specId: "C", runId: "run-c", branch: "feature/c", headSha: "sha-c" },
  ];
  const baseSha = "sha-main";
  return {
    node_id: "inode_evidence",
    base_sha: baseSha,
    head_sha: "sha-integrated",
    tree_hash: "tree-integrated",
    members,
    member_key: memberKey(
      baseSha,
      members.map((member) => member.headSha),
    ),
    gate_config_hash: "gate-v7",
    policy_version: "policy-v7",
  };
}

export function validBatchProof(input: {
  verdict: "passed" | "failed";
  node?: StoredBatchNode;
  quarantineVersion?: string;
  mutateEvidence?: (evidence: ReturnType<typeof buildBatchGateProofEvidence>) => unknown;
}): StoredBatchProof {
  const node = input.node ?? validBatchNode();
  const keyInput = {
    memberKey: node.member_key,
    gateConfigHash: node.gate_config_hash,
    policyVersion: node.policy_version,
    runnerImage: "runner@sha256:abc",
    appEnvHash: "env-v7",
    quarantineVersion: input.quarantineVersion ?? activeQuarantineVersion({ checkNames: new Set(), testIds: [] }),
  };
  const proofKey = proofReuseKey(keyInput);
  const evidence = buildBatchGateProofEvidence({
    nodeId: node.node_id,
    headSha: node.head_sha,
    treeHash: node.tree_hash,
    memberSetHash: node.member_key,
    keyInput,
    passed: input.verdict === "passed",
    ...(input.verdict === "failed" ? { message: "integrated unit failure" } : {}),
  });
  return {
    ...node,
    proof_id: "proof-evidence",
    proof_created_at: new Date("2026-07-15T12:20:00.000Z"),
    proof_reuse_key: proofKey,
    proof_verdict: input.verdict,
    proof_evidence: input.mutateEvidence?.(evidence) ?? evidence,
  };
}

export function validQuarantine(headSha = validBatchNode().head_sha): StoredQuarantine {
  return {
    id: "quarantine-toggle",
    check_name: "unit",
    test_id: "suite#toggle",
    toggled_sha_count: 1,
    observation_count: 2,
    evidence: {
      checkName: "unit",
      testId: "suite#toggle",
      toggledShaCount: 1,
      observationCount: 2,
      sampleShas: [headSha],
    },
    quarantined_at: new Date("2026-07-15T12:25:00.000Z"),
  };
}

export function quarantineVersion(quarantineRows: ReadonlyArray<StoredQuarantine>): string {
  return activeQuarantineVersion({
    checkNames: new Set(quarantineRows.map((row) => row.check_name)),
    testIds: quarantineRows.flatMap((row) => (row.test_id === null ? [] : [row.test_id])),
  });
}

export function nodeGroupId(node: StoredBatchNode): string {
  return authorityDerivedId("mqgrp", {
    memberSetHash: node.member_key,
    members: node.members.map((member) => ({ runId: member.runId, specId: member.specId })),
    subject: { id: node.node_id, kind: "integration_node" },
  });
}

function artifactDigest(headSha: string, treeHash: string): string {
  return `sha256:${createHash("sha256")
    .update("tanren:merge-batch-artifact:v1\0")
    .update(headSha)
    .update("\0")
    .update(treeHash)
    .digest("hex")}`;
}

export function decisionEvaluationId(decision: StoredDecision): string {
  return authorityDerivedId("mqeval", {
    decisionId: decision.decision_id,
    durableSource: "authority_decision.v1",
    node: {
      artifactDigest: decision.artifact_digest,
      baseSha: decision.base_sha,
      headSha: decision.node_head_sha,
      id: decision.node_id,
      memberSetHash: decision.member_key,
      members: decision.members.map((member) => ({
        branch: member.branch,
        headSha: member.headSha,
        runId: member.runId,
        specId: member.specId,
      })),
      policyVersion: decision.node_policy_version,
      proofReuseKey: decision.proof_reuse_key,
      treeHash: decision.tree_hash,
    },
  });
}

/** Sound deterministic exact-node binding for coordinator unit tests. */
export function fakeBatchAuthorityBinding(entries: ReadonlyArray<MergeQueueEntry>): BatchAuthorityBinding {
  const baseSha = "test-main-before";
  const members = entries.map((entry) => ({
    specId: entry.specId,
    runId: entry.runId,
    branch: `tanren/${entry.specId}`,
    headSha: `test-head-${entry.runId}`,
  }));
  const memberSetHash = memberKey(
    baseSha,
    members.map((member) => member.headSha),
  );
  const keyInput = {
    memberKey: memberSetHash,
    gateConfigHash: "test-gate",
    policyVersion: "1",
    runnerImage: "test-runner",
    appEnvHash: "test-env",
    quarantineVersion: "test-quarantine",
  };
  return {
    nodeId: `inode-test-${memberSetHash.slice(0, 12)}`,
    baseBranch: "main",
    baseSha,
    headSha: `test-batch-${entries.at(-1)?.runId ?? "empty"}`,
    treeHash: `test-tree-${memberSetHash}`,
    members,
    memberSetHash,
    policyVersion: keyInput.policyVersion,
    proof: { verdict: "passed", proofReuseKey: proofReuseKey(keyInput), keyInput },
  };
}

/** Explicit all-admit evaluator used only by pre-MQ-2 coordinator behavior tests. */
export function allowExactBatchAuthority(): BatchAuthorityEvaluator {
  return {
    async evaluate({ entries, binding }) {
      const envelope = {
        subject: { kind: "integration_node" as const, id: binding.nodeId },
        members: binding.members.map((member) => ({ ...member, disposition: "admit" as const })),
        headSha: binding.headSha,
        expectedMainSha: binding.baseSha,
        artifactDigest: batchArtifactDigest(binding),
        proofRoot: batchProofRoot(binding),
        memberSetHash: binding.memberSetHash,
        policyVersion: binding.policyVersion,
        target: { repo: { owner: "test", name: "repo" }, intoMain: "main" },
      };
      return {
        kind: "authorized_subset",
        evaluationId: `mqeval_test_${binding.memberSetHash}`,
        groupId: `mqgrp_test_${binding.memberSetHash}`,
        version: MULTI_MEMBER_AUTHORITY_VERSION,
        nodeId: binding.nodeId,
        memberSetHash: binding.memberSetHash,
        proofReuseKey: binding.proof.proofReuseKey,
        members: binding.members.map((member) => ({
          ...member,
          disposition: "admit" as const,
          findingIds: [],
          reasonCodes: [],
        })),
        reasonCodes: [],
        authorizedMemberIds: entries.map((entry) => entry.specId),
        eligibleMemberIds: entries.map((entry) => entry.specId),
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
        authorization: {
          decision: "authorized",
          subject: envelope.subject,
          envelope,
          reasons: [],
        },
      };
    },
  };
}
