// cspell:ignore mqeval mqgrp
import type pg from "pg";
import type { IntegrationNodeMember } from "../../engine/contracts/integrationNodes.js";
import { memberKey } from "../../engine/contracts/integrationNodes.js";
import { CiFlakyDetectedPayload } from "../../engine/events/schemas/ciFlaky.js";
import { MergeSignalClassifiedPayload } from "../../engine/events/schemas/eventVocabularyW0.js";
import { authorityDerivedId } from "../../engine/merge/authoritySignalIdentity.js";
import {
  BatchGateProofEvidenceV1,
  exactBatchGateProofEvidence,
  type BatchGateEvidenceBinding,
} from "../../engine/merge/multiMemberAuthorityEvidence.js";
import { activeQuarantineVersion } from "../../engine/workflow/ciQuarantine.js";

export interface AuthorityEvaluationMemberData {
  readonly ordinal: number;
  readonly specId: string;
  readonly runId: string | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly disposition: "admit" | "exclude" | "hold" | "bisect";
  readonly findingIds: ReadonlyArray<string>;
  readonly reasonCodes: ReadonlyArray<string>;
}

export interface AuthorityEvaluationProjectionData {
  readonly evaluationId: string;
  readonly groupId: string;
  readonly kind:
    | "authorized_subset"
    | "member_failure"
    | "interaction_failure"
    | "flake_observation"
    | "transient_infrastructure"
    | "needs_product_decision"
    | "unknown_fail_closed";
  readonly observedAt: string;
  readonly source: "merge.signal.classified" | "authority_decision" | "batch_gate" | "quarantine";
  readonly sourceId: string;
  readonly nodeId: string | null;
  readonly memberSetHash: string | null;
  readonly proofReuseKey: string | null;
  readonly members: ReadonlyArray<AuthorityEvaluationMemberData>;
  readonly findingIds: ReadonlyArray<string>;
  readonly reasonCodes: ReadonlyArray<string>;
  readonly eligibleMemberIds: ReadonlyArray<string>;
}

export interface DurableSignalRow {
  readonly event_id: string;
  readonly ts: Date | string;
  readonly payload: unknown;
}

interface BatchNodeRow {
  node_id: string;
  base_sha: string;
  head_sha: string | null;
  tree_hash: string | null;
  members: unknown;
  member_key: string;
  gate_config_hash: string;
  policy_version: string;
}

interface BatchProofRow extends BatchNodeRow {
  proof_id: string;
  proof_created_at: Date | string;
  proof_reuse_key: string;
  proof_verdict: string;
  proof_evidence: unknown;
}

interface QuarantineRow {
  id: string;
  check_name: string;
  test_id: string | null;
  toggled_sha_count: number;
  observation_count: number;
  evidence: unknown;
  quarantined_at: Date | string;
}

interface SpecRow {
  spec_id: string;
  depends_on: unknown;
}

interface ExactNode {
  readonly row: BatchNodeRow;
  readonly members: ReadonlyArray<IntegrationNodeMember>;
  readonly groupId: string;
}

export interface ExactBatchProofInput {
  readonly nodeId: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly gateConfigHash: string;
  readonly policyVersion: string;
  readonly proofReuseKey: string;
  readonly proofEvidence: unknown;
}

export function exactBatchProofForNode(
  input: ExactBatchProofInput,
  verdict: "passed" | "failed",
): BatchGateProofEvidenceV1 | undefined {
  const parsed = BatchGateProofEvidenceV1.safeParse(input.proofEvidence);
  if (!parsed.success) return undefined;
  const binding: BatchGateEvidenceBinding = {
    nodeId: input.nodeId,
    headSha: input.headSha,
    treeHash: input.treeHash,
    memberSetHash: input.memberSetHash,
    proof: { proofReuseKey: input.proofReuseKey, keyInput: parsed.data.keyInput },
  };
  return parsed.data.keyInput.memberKey === input.memberSetHash &&
    parsed.data.keyInput.gateConfigHash === input.gateConfigHash &&
    parsed.data.keyInput.policyVersion === input.policyVersion
    ? exactBatchGateProofEvidence(input.proofEvidence, binding, verdict)
    : undefined;
}

export async function projectDurableSignals(
  client: pg.PoolClient,
  projectId: string,
  orgId: string,
  rows: ReadonlyArray<DurableSignalRow>,
): Promise<AuthorityEvaluationProjectionData[]> {
  const parsed = rows.map((row) => ({ row, signal: MergeSignalClassifiedPayload.parse(row.payload) }));
  const needsProvenance = parsed.some(({ signal }) => signal.classification === "deterministic_policy");
  const provenance = needsProvenance ? await loadNodeProvenance(client, projectId, orgId) : new Map();
  return parsed.map(({ row, signal }) => {
    const exact = signal.classification === "deterministic_policy" ? provenance.get(signal.groupId) : undefined;
    const enriched = exact === undefined ? undefined : memberFailureProvenance(signal.memberIds, exact);
    const kind = signal.classification === "deterministic_policy" ? "member_failure" : signal.classification;
    const fallbackMembers = signal.memberIds.map((specId, ordinal) => ({
      ordinal,
      specId,
      runId: null,
      branch: null,
      headSha: null,
      disposition: signal.classification === "deterministic_policy" ? ("exclude" as const) : ("hold" as const),
      findingIds: [],
      reasonCodes: [signal.reasonCode],
    }));
    return {
      evaluationId: signal.evaluationId,
      groupId: signal.groupId,
      kind,
      observedAt: iso(row.ts),
      source: "merge.signal.classified",
      sourceId: row.event_id,
      nodeId: enriched?.nodeId ?? null,
      memberSetHash: enriched?.memberSetHash ?? null,
      proofReuseKey: null,
      members: enriched?.members ?? fallbackMembers,
      findingIds: signal.findingIds,
      reasonCodes: [signal.reasonCode],
      eligibleMemberIds: enriched?.eligibleMemberIds ?? [],
    };
  });
}

export async function readDurableBatchEvidence(
  client: pg.PoolClient,
  projectId: string,
  orgId: string,
  limit: number | undefined,
): Promise<AuthorityEvaluationProjectionData[]> {
  const values: unknown[] = [projectId, orgId];
  const limitSql = limit === undefined ? "" : "LIMIT $3";
  if (limit !== undefined) values.push(limit);
  const proofs = (
    await client.query<BatchProofRow>(
      `SELECT p.proof_id, p.created_at AS proof_created_at,
              p.proof_reuse_key, p.verdict AS proof_verdict, p.evidence AS proof_evidence,
              n.node_id, n.base_sha, n.head_sha, n.tree_hash, n.members, n.member_key,
              n.gate_config_hash, n.policy_version
         FROM integration_proofs p
         JOIN integration_nodes n
           ON n.org_id = p.org_id AND n.project_id = p.project_id AND n.node_id = p.node_id
        WHERE p.project_id = $1 AND p.org_id = $2 AND n.purpose = 'merge_batch'
        ORDER BY p.created_at DESC, p.proof_id DESC
        ${limitSql}`,
      values,
    )
  ).rows;
  if (proofs.length === 0) return [];
  const quarantines = (
    await client.query<QuarantineRow>(
      `SELECT id, check_name, test_id, toggled_sha_count, observation_count, evidence, quarantined_at
         FROM quarantined_tests
        WHERE project_id = $1 AND cleared_at IS NULL
        ORDER BY quarantined_at, id`,
      [projectId],
    )
  ).rows;
  const quarantineVersion = activeQuarantineVersion({
    checkNames: new Set(quarantines.map((row) => row.check_name).filter((value) => value !== "")),
    testIds: quarantines.flatMap((row) => (row.test_id === null || row.test_id === "" ? [] : [row.test_id])),
  });
  return proofs.flatMap((row) => projectProof(row, quarantines, quarantineVersion));
}

async function loadNodeProvenance(
  client: pg.PoolClient,
  projectId: string,
  orgId: string,
): Promise<Map<string, ExactNode & { readonly dependencies: ReadonlyMap<string, ReadonlyArray<string>> }>> {
  const rows = (
    await client.query<BatchNodeRow>(
      `SELECT node_id, base_sha, head_sha, tree_hash, members, member_key,
              gate_config_hash, policy_version
         FROM integration_nodes
        WHERE project_id = $1 AND org_id = $2 AND purpose = 'merge_batch'`,
      [projectId, orgId],
    )
  ).rows;
  const exactNodes = rows.flatMap((row) => {
    const exact = decodeExactNode(row);
    return exact === undefined ? [] : [exact];
  });
  const memberIds = [...new Set(exactNodes.flatMap((node) => node.members.map((member) => member.specId)))];
  if (memberIds.length === 0) return new Map();
  const specs = (
    await client.query<SpecRow>(
      `SELECT spec_id, depends_on
         FROM specs
        WHERE project_id = $1 AND org_id = $2 AND spec_id = ANY($3::text[])`,
      [projectId, orgId, memberIds],
    )
  ).rows;
  const dependencies = new Map<string, ReadonlyArray<string>>();
  for (const row of specs) {
    const dependsOn = stringArray(row.depends_on);
    if (dependsOn !== undefined) dependencies.set(row.spec_id, dependsOn);
  }
  const byGroup = new Map<string, ExactNode & { readonly dependencies: ReadonlyMap<string, ReadonlyArray<string>> }>();
  for (const node of exactNodes) {
    if (node.members.some((member) => !dependencies.has(member.specId))) continue;
    if (byGroup.has(node.groupId)) {
      byGroup.delete(node.groupId);
      continue;
    }
    byGroup.set(node.groupId, { ...node, dependencies });
  }
  return byGroup;
}

function memberFailureProvenance(
  failedMemberIds: ReadonlyArray<string>,
  node: ExactNode & { readonly dependencies: ReadonlyMap<string, ReadonlyArray<string>> },
):
  | { nodeId: string; memberSetHash: string; members: AuthorityEvaluationMemberData[]; eligibleMemberIds: string[] }
  | undefined {
  const nodeMemberIds = new Set(node.members.map((member) => member.specId));
  if (failedMemberIds.some((memberId) => !nodeMemberIds.has(memberId))) return undefined;
  const failed = new Set(failedMemberIds);
  const held = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of node.members) {
      if (failed.has(member.specId) || held.has(member.specId)) continue;
      const dependsOn = node.dependencies.get(member.specId) ?? [];
      if (!dependsOn.some((dependency) => failed.has(dependency) || held.has(dependency))) continue;
      held.add(member.specId);
      changed = true;
    }
  }
  const members = node.members.map((member, ordinal) => ({
    ordinal,
    ...member,
    disposition: failed.has(member.specId)
      ? ("exclude" as const)
      : held.has(member.specId)
        ? ("hold" as const)
        : ("admit" as const),
    findingIds: [],
    reasonCodes: failed.has(member.specId) ? ["audit_policy"] : held.has(member.specId) ? ["dependency_failed"] : [],
  }));
  return {
    nodeId: node.row.node_id,
    memberSetHash: node.row.member_key,
    members,
    eligibleMemberIds: members.filter((member) => member.disposition === "admit").map((member) => member.specId),
  };
}

function projectProof(
  row: BatchProofRow,
  quarantines: ReadonlyArray<QuarantineRow>,
  quarantineVersion: string,
): AuthorityEvaluationProjectionData[] {
  const node = decodeExactNode(row);
  if (node === undefined) return [];
  if (row.proof_verdict !== "passed" && row.proof_verdict !== "failed") {
    return [unknownProofProjection(row, node)];
  }
  const evidence = exactBatchProofForNode(
    {
      nodeId: row.node_id,
      headSha: row.head_sha!,
      treeHash: row.tree_hash!,
      memberSetHash: row.member_key,
      gateConfigHash: row.gate_config_hash,
      policyVersion: row.policy_version,
      proofReuseKey: row.proof_reuse_key,
      proofEvidence: row.proof_evidence,
    },
    row.proof_verdict,
  );
  if (evidence === undefined) return [unknownProofProjection(row, node)];
  if (row.proof_verdict === "failed") return [interactionProjection(row, node)];
  if (evidence.keyInput.quarantineVersion !== quarantineVersion) return [];
  const quarantine = quarantines.find((candidate) => exactQuarantineForHead(candidate, row.head_sha!));
  return quarantine === undefined ? [] : [flakeProjection(row, node, quarantine, quarantineVersion)];
}

function interactionProjection(row: BatchProofRow, node: ExactNode): AuthorityEvaluationProjectionData {
  return {
    ...commonProofProjection(row, node, "batch_gate", row.proof_id, row.proof_created_at),
    evaluationId: authorityDerivedId("mqeval", {
      durableSource: "batch_gate.v1",
      node: nodeIdentity(row, node.members),
      proofId: row.proof_id,
      proofReuseKey: row.proof_reuse_key,
      verdict: "failed",
    }),
    kind: "interaction_failure",
    members: heldMembers(node.members, "interaction_failure"),
    reasonCodes: ["integrated_gate_failure_under_bisect"],
  };
}

function flakeProjection(
  row: BatchProofRow,
  node: ExactNode,
  quarantine: QuarantineRow,
  quarantineVersion: string,
): AuthorityEvaluationProjectionData {
  return {
    ...commonProofProjection(row, node, "quarantine", quarantine.id, quarantine.quarantined_at),
    // The id is derived from the REAL durable ci-flaky quarantine row and its proven toggle
    // facts (id, toggle/observation counts) that `exactQuarantineForHead` validated against
    // this exact proven head — never from synthesized per-verdict observation ids.
    evaluationId: authorityDerivedId("mqeval", {
      durableSource: "quarantine.v1",
      node: nodeIdentity(row, node.members),
      observationCount: quarantine.observation_count,
      proofReuseKey: row.proof_reuse_key,
      quarantineId: quarantine.id,
      quarantineVersion,
      toggledShaCount: quarantine.toggled_sha_count,
    }),
    kind: "flake_observation",
    members: heldMembers(node.members, "flake_observation"),
    reasonCodes: ["same_tree_nondeterminism"],
  };
}

function unknownProofProjection(row: BatchProofRow, node: ExactNode): AuthorityEvaluationProjectionData {
  return {
    ...commonProofProjection(row, node, "batch_gate", row.proof_id, row.proof_created_at),
    evaluationId: authorityDerivedId("mqeval", {
      durableSource: "batch_gate.invalid.v1",
      node: nodeIdentity(row, node.members),
      proofId: row.proof_id,
      proofReuseKey: row.proof_reuse_key,
      verdict: row.proof_verdict,
    }),
    kind: "unknown_fail_closed",
    members: heldMembers(node.members, "unknown_fail_closed"),
    reasonCodes: ["incomplete_batch_gate_evidence"],
  };
}

function commonProofProjection(
  row: BatchProofRow,
  node: ExactNode,
  source: "batch_gate" | "quarantine",
  sourceId: string,
  observedAt: Date | string,
): Omit<AuthorityEvaluationProjectionData, "evaluationId" | "kind" | "members" | "reasonCodes"> {
  return {
    groupId: node.groupId,
    observedAt: iso(observedAt),
    source,
    sourceId,
    nodeId: row.node_id,
    memberSetHash: row.member_key,
    proofReuseKey: row.proof_reuse_key,
    findingIds: [],
    eligibleMemberIds: [],
  };
}

function decodeExactNode(row: BatchNodeRow): ExactNode | undefined {
  const members = decodeMembers(row.members);
  if (
    members.length < 2 ||
    row.node_id === "" ||
    row.base_sha === "" ||
    row.head_sha === null ||
    row.head_sha === "" ||
    row.tree_hash === null ||
    row.tree_hash === "" ||
    row.member_key !==
      memberKey(
        row.base_sha,
        members.map((member) => member.headSha),
      )
  ) {
    return undefined;
  }
  const identities = members.map((member) => `${member.specId}\0${member.runId}`);
  if (new Set(identities).size !== identities.length) return undefined;
  return {
    row,
    members,
    groupId: authorityDerivedId("mqgrp", {
      memberSetHash: row.member_key,
      members: members.map((member) => ({ runId: member.runId, specId: member.specId })),
      subject: { id: row.node_id, kind: "integration_node" },
    }),
  };
}

function decodeMembers(value: unknown): IntegrationNodeMember[] {
  if (!Array.isArray(value)) return [];
  const members: IntegrationNodeMember[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object") return [];
    const parts = ["specId", "runId", "branch", "headSha"].map((key) => Reflect.get(candidate, key));
    if (!parts.every((part) => typeof part === "string" && part.trim() !== "")) return [];
    const [specId, runId, branch, headSha] = parts as [string, string, string, string];
    members.push({ specId, runId, branch, headSha });
  }
  return members;
}

function exactQuarantineForHead(row: QuarantineRow, headSha: string): boolean {
  const evidence = CiFlakyDetectedPayload.safeParse(row.evidence);
  return (
    evidence.success &&
    evidence.data.checkName === row.check_name &&
    (evidence.data.testId ?? null) === row.test_id &&
    evidence.data.toggledShaCount === row.toggled_sha_count &&
    evidence.data.observationCount === row.observation_count &&
    evidence.data.sampleShas.includes(headSha)
  );
}

function heldMembers(
  members: ReadonlyArray<IntegrationNodeMember>,
  reasonCode: string,
): AuthorityEvaluationMemberData[] {
  return members.map((member, ordinal) => ({
    ordinal,
    ...member,
    disposition: "hold",
    findingIds: [],
    reasonCodes: [reasonCode],
  }));
}

function nodeIdentity(row: BatchNodeRow, members: ReadonlyArray<IntegrationNodeMember>) {
  return {
    baseSha: row.base_sha,
    headSha: row.head_sha!,
    id: row.node_id,
    memberSetHash: row.member_key,
    members: members.map((member) => ({
      branch: member.branch,
      headSha: member.headSha,
      runId: member.runId,
      specId: member.specId,
    })),
    policyVersion: row.policy_version,
    treeHash: row.tree_hash!,
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "")
    ? value
    : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
