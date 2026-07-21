// PostgreSQL readers for the sole decisive V2 gate-evidence surface. A legacy
// `integration_proofs` row is intentionally never read by merge authority.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { BudgetScope, ConflictResolution, GateVerdict, MergeabilityState } from "../contracts/mergeAuthority.js";
import { GitHubOutageError } from "../providers/githubRetry.js";
import { PgBudgetGate } from "../dag/budgetGate.js";
import type { GateProofBundleVerifier } from "./gateProofBundleTypes.js";
import { budgetScopeFrom } from "./mergeAuthorityInputs.js";
import { MultiMemberAuthorityInfrastructureFault } from "./multiMemberAuthorityEvidence.js";

interface PersistedBatchRow {
  node_id: string;
  base_sha: string;
  head_sha: string | null;
  tree_hash: string | null;
  status: string;
  members: unknown;
  member_key: string;
  gate_config_hash: string;
  policy_version: string;
}

export interface PersistedBatchDecisionSignals {
  readonly gateVerdict: GateVerdict;
  readonly mergeability: MergeabilityState;
  readonly conflicts: ConflictResolution;
}

/** Gather the exact V2-proof-bound decision inputs for an integration node. */
export async function loadBatchDecisionEvidence(
  pool: pg.Pool,
  gateProofs: GateProofBundleVerifier,
  orgId: string,
  projectId: string,
  binding: BatchAuthorityBinding,
): Promise<{
  readonly persisted: PersistedBatchDecisionSignals;
  readonly budget: BudgetScope;
}> {
  const [persisted, rawBudget] = await Promise.all([
    loadPersistedBatchDecisionSignals(pool, gateProofs, orgId, projectId, binding),
    new PgBudgetGate(pool).resolveBudget(projectId),
  ]);
  const budget = budgetScopeFrom({
    ceilingUsd: rawBudget.ceilingUsd,
    spentUsd: rawBudget.spentUsd,
    ...(rawBudget.failClosed === undefined ? {} : { failClosedReason: `budget ${rawBudget.failClosed}` }),
  });
  return { persisted, budget };
}

/**
 * A node is clean/resolved only after its sealed V2 proof validates at the exact
 * head/tree/member/config/policy coordinate. Absence, malformed fields, and a
 * verifier error are all unknown — never a pass.
 */
export async function loadPersistedBatchDecisionSignals(
  pool: pg.Pool,
  gateProofs: GateProofBundleVerifier,
  orgId: string,
  projectId: string,
  binding: BatchAuthorityBinding,
): Promise<PersistedBatchDecisionSignals> {
  try {
    const row = await runWithOrgScope(pool, orgId, async (client) => {
      const result = await client.query<PersistedBatchRow>(
        `SELECT node_id, base_sha, head_sha, tree_hash, status, members,
                member_key, gate_config_hash, policy_version
           FROM integration_nodes
          WHERE org_id = $1 AND project_id = $2 AND member_key = $3`,
        [orgId, projectId, binding.memberSetHash],
      );
      return result.rows[0];
    });
    if (row === undefined || !exactNode(row, binding)) return unknownSignals();
    const exactV2 = await gateProofs.verifyExact({
      orgId,
      projectId,
      nodeId: binding.nodeId,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
      memberSetHash: binding.memberSetHash,
      members: binding.members,
      gateConfigHash: binding.gateConfigHash,
      policyVersion: binding.policyVersion,
      gateProofBundleId: binding.proof.gateProofBundleId,
      proofBundleDigest: binding.proof.proofBundleDigest,
      proofRoot: binding.proof.proofRoot,
    });
    return exactV2 ? { gateVerdict: "passed", mergeability: "clean", conflicts: "resolved" } : unknownSignals();
  } catch {
    return unknownSignals();
  }
}

/** Preserve typed provider outages; untyped/config failures remain unknown. */
export function rethrowTypedCodeHostInfrastructure(error: unknown, binding: BatchAuthorityBinding): never {
  const retriable =
    error instanceof Error && typeof (error as unknown as { retriable?: unknown }).retriable === "boolean"
      ? (error as unknown as { retriable: boolean }).retriable
      : undefined;
  if (error instanceof GitHubOutageError || retriable === true) {
    throw new MultiMemberAuthorityInfrastructureFault({
      kind: "infrastructure",
      reasonCode: "code_host_unavailable",
      sourceKey: `mq2:${binding.nodeId}:code-host`,
    });
  }
  throw error;
}

function exactNode(row: PersistedBatchRow, binding: BatchAuthorityBinding): boolean {
  return (
    row.node_id === binding.nodeId &&
    row.base_sha === binding.baseSha &&
    row.head_sha === binding.headSha &&
    row.tree_hash === binding.treeHash &&
    row.status === "ready" &&
    row.member_key === binding.memberSetHash &&
    row.gate_config_hash === binding.gateConfigHash &&
    row.policy_version === binding.policyVersion &&
    sameMembers(row.members, binding.members)
  );
}

function sameMembers(raw: unknown, expected: BatchAuthorityBinding["members"]): boolean {
  if (!Array.isArray(raw) || raw.length !== expected.length) return false;
  return raw.every((candidate, index) => {
    if (candidate === null || typeof candidate !== "object") return false;
    const member = expected[index];
    return (
      member !== undefined &&
      Reflect.get(candidate, "specId") === member.specId &&
      Reflect.get(candidate, "runId") === member.runId &&
      Reflect.get(candidate, "branch") === member.branch &&
      Reflect.get(candidate, "headSha") === member.headSha
    );
  });
}

function unknownSignals(): PersistedBatchDecisionSignals {
  return { gateVerdict: "unknown", mergeability: "unknown", conflicts: "unresolved" };
}
