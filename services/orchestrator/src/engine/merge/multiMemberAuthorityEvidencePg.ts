// PostgreSQL readers for MQ-2's existing proof/quarantine surfaces. These are
// read-only: the native gate remains the sole integration-proof writer and the CI
// insights engine remains the sole quarantine writer.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { BudgetScope, ConflictResolution, GateVerdict, MergeabilityState } from "../contracts/mergeAuthority.js";
import { CiFlakyDetectedPayload } from "../events/schemas/ciFlaky.js";
import { GitHubOutageError } from "../providers/githubRetry.js";
import { PgBudgetGate } from "../dag/budgetGate.js";
import { activeQuarantineVersion, loadActiveQuarantine } from "../workflow/ciQuarantine.js";
import {
  exactBatchGateProofEvidence,
  MultiMemberAuthorityInfrastructureFault,
} from "./multiMemberAuthorityEvidence.js";
import type { SameTreeFlakeEvidence } from "./multiMemberAuthorityTypes.js";
import { budgetScopeFrom } from "./mergeAuthorityInputs.js";

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
  proof_reuse_key: string | null;
  proof_verdict: string | null;
  proof_evidence: unknown;
}

export interface PersistedBatchDecisionSignals {
  readonly gateVerdict: GateVerdict;
  readonly mergeability: MergeabilityState;
  readonly conflicts: ConflictResolution;
}

/** Gather the proof-bound decision inputs that share one exact persisted node. */
export async function loadBatchDecisionEvidence(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  binding: BatchAuthorityBinding,
): Promise<{
  readonly persisted: PersistedBatchDecisionSignals;
  readonly budget: BudgetScope;
  readonly evidence?: SameTreeFlakeEvidence;
}> {
  const [persisted, rawBudget] = await Promise.all([
    loadPersistedBatchDecisionSignals(pool, orgId, projectId, binding),
    new PgBudgetGate(pool).resolveBudget(projectId),
  ]);
  const evidence = await loadExactSameTreeFlakeEvidence(pool, orgId, projectId, binding, persisted);
  const budget = budgetScopeFrom({
    ceilingUsd: rawBudget.ceilingUsd,
    spentUsd: rawBudget.spentUsd,
    ...(rawBudget.failClosed === undefined ? {} : { failClosedReason: `budget ${rawBudget.failClosed}` }),
  });
  return { persisted, budget, ...(evidence === undefined ? {} : { evidence }) };
}

/** Read the exact node/proof facts that replace hard-coded clean authority inputs. */
export async function loadPersistedBatchDecisionSignals(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  binding: BatchAuthorityBinding,
): Promise<PersistedBatchDecisionSignals> {
  const row = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<PersistedBatchRow>(
      `SELECT n.node_id, n.base_sha, n.head_sha, n.tree_hash, n.status, n.members,
              n.member_key, n.gate_config_hash, n.policy_version,
              p.proof_reuse_key, p.verdict AS proof_verdict, p.evidence AS proof_evidence
         FROM integration_nodes n
         LEFT JOIN integration_proofs p
           ON p.org_id = n.org_id AND p.project_id = n.project_id
          AND p.node_id = n.node_id AND p.proof_reuse_key = $4
        WHERE n.org_id = $1 AND n.project_id = $2 AND n.member_key = $3`,
      [orgId, projectId, binding.memberSetHash, binding.proof.proofReuseKey],
    );
    return result.rows[0];
  });
  if (row === undefined || !exactNode(row, binding)) return unknownSignals();
  if (row.proof_verdict === "passed") {
    return exactBatchGateProofEvidence(row.proof_evidence, binding, "passed") === undefined
      ? unknownSignals()
      : { gateVerdict: "passed", mergeability: "clean", conflicts: "resolved" };
  }
  if (
    row.proof_verdict === "failed" &&
    exactBatchGateProofEvidence(row.proof_evidence, binding, "failed") !== undefined
  ) {
    return { gateVerdict: "failed", mergeability: "clean", conflicts: "resolved" };
  }
  return unknownSignals();
}

/** Exact current active-set identity used by proof reuse and authority freshness. */
export async function loadCurrentQuarantineVersion(pool: pg.Pool, orgId: string, projectId: string): Promise<string> {
  return runWithOrgScope(pool, orgId, async (client) =>
    activeQuarantineVersion(await loadActiveQuarantine(client, projectId)),
  );
}

/** A quarantine row is flake evidence only when it attests this exact proven head. */
export async function loadExactSameTreeFlakeEvidence(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  binding: BatchAuthorityBinding,
  signals: PersistedBatchDecisionSignals,
): Promise<SameTreeFlakeEvidence | undefined> {
  if (signals.gateVerdict !== "passed") return undefined;
  return runWithOrgScope(pool, orgId, async (client) => {
    const active = await loadActiveQuarantine(client, projectId);
    const version = activeQuarantineVersion(active);
    let match: SameTreeFlakeEvidence | undefined;
    if (version !== binding.proof.keyInput.quarantineVersion) return match;
    const result = await client.query<{ id: string; evidence: unknown }>(
      `SELECT id, evidence
         FROM quarantined_tests
        WHERE project_id = $1 AND cleared_at IS NULL
        ORDER BY quarantined_at, id`,
      [projectId],
    );
    for (const row of result.rows) {
      const evidence = CiFlakyDetectedPayload.safeParse(row.evidence);
      if (!evidence.success || !evidence.data.sampleShas.includes(binding.headSha)) continue;
      match = {
        kind: "same_tree_flake",
        treeHash: binding.treeHash,
        quarantineVersion: version,
        observations: [
          { id: `${row.id}:failed`, verdict: "failed" },
          { id: `${row.id}:passed`, verdict: "passed" },
        ],
      };
      break;
    }
    return match;
  });
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
    row.gate_config_hash === binding.proof.keyInput.gateConfigHash &&
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
