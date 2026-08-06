// gv-17: authoritative member-vector lineage for integration_nodes.
// Normalized rows are the source of truth; the JSON `members` column is a
// dual-written compatibility mirror. Any JSON/row/member_key divergence fails
// closed so materialization, revalidation, and land cannot proceed on a lie.

import type pg from "pg";
import { memberKey, type IntegrationNodeMember } from "../contracts/integrationNodes.js";

/** Anything that can run a query — a pool or an already-checked-out scoped client. */
type QueryRunner = Pick<pg.PoolClient, "query">;

/** Raised when persisted member rows diverge from the JSON mirror or stored key. */
export class MemberLineageDivergenceError extends Error {
  readonly code = "member_lineage_divergence" as const;
  constructor(
    readonly nodeId: string,
    reason: string,
  ) {
    super(`integration node ${nodeId} member lineage diverged: ${reason}`);
    this.name = "MemberLineageDivergenceError";
  }
}

interface MemberRow {
  ordinal: number;
  spec_id: string;
  run_id: string;
  branch: string;
  head_sha: string;
  included: boolean;
}

/** Exact ordered equality for two member vectors (order is load-bearing). */
export function sameOrderedMembers(
  left: ReadonlyArray<IntegrationNodeMember>,
  right: ReadonlyArray<IntegrationNodeMember>,
): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        member.specId === candidate.specId &&
        member.runId === candidate.runId &&
        member.branch === candidate.branch &&
        member.headSha === candidate.headSha
      );
    })
  );
}

/** Decode the legacy JSON members column into typed ordered members (strict). */
export function decodeMembersStrict(value: unknown, nodeId: string): IntegrationNodeMember[] {
  if (!Array.isArray(value)) {
    throw new MemberLineageDivergenceError(nodeId, "members jsonb is not an array");
  }
  const out: IntegrationNodeMember[] = [];
  for (const [index, m] of value.entries()) {
    if (m === null || typeof m !== "object") {
      throw new MemberLineageDivergenceError(nodeId, `members[${index}] is not an object`);
    }
    const specId = Reflect.get(m, "specId");
    const runId = Reflect.get(m, "runId");
    const branch = Reflect.get(m, "branch");
    const headSha = Reflect.get(m, "headSha");
    if (
      typeof specId !== "string" ||
      typeof runId !== "string" ||
      typeof branch !== "string" ||
      typeof headSha !== "string" ||
      specId === "" ||
      runId === "" ||
      branch === "" ||
      headSha === ""
    ) {
      throw new MemberLineageDivergenceError(nodeId, `members[${index}] missing required string fields`);
    }
    out.push({ specId, runId, branch, headSha });
  }
  return out;
}

/** Persisted node row shape used by authoritative reads. */
export interface IntegrationNodeRowShape {
  node_id: string;
  base_branch: string;
  base_sha: string;
  ref: string;
  purpose: string;
  members: unknown;
  member_key: string;
  gate_config_hash: string;
  policy_version: string;
  affected_fingerprint: string;
  head_sha: string | null;
  tree_hash: string | null;
  status: string;
}

/**
 * Load every authoritative node for a dependent run (member participation or branch ref).
 * Callers map rows through {@link loadAuthoritativeMembers}.
 *
 * The result is a UNION of two DIFFERENT things: the run's OWN branch-ref node, and every
 * merge-batch / eager-beam node that merely lists the run as a member. `node_id` is a random
 * uuid, so a bare `ORDER BY node_id` made "the first row" a coin flip; the run's own node
 * sorts FIRST here. Consumers that need a specific node must still select by identity (a
 * caller must never depend on this ordering for correctness) — this only makes the read
 * reproducible.
 */
export async function selectNodesForDependentRun(
  client: QueryRunner,
  input: { projectId: string; runId: string; branch: string },
): Promise<IntegrationNodeRowShape[]> {
  const result = await client.query<IntegrationNodeRowShape>(
    `SELECT DISTINCT n.node_id, n.base_branch, n.base_sha, n.ref, n.purpose, n.members, n.member_key,
            n.gate_config_hash, n.policy_version, n.affected_fingerprint, n.head_sha,
            n.tree_hash, n.status
       FROM integration_nodes n
      WHERE n.project_id = $1
        AND (
          n.ref = $2
          OR EXISTS (
            SELECT 1 FROM integration_node_members m
             WHERE m.org_id = n.org_id AND m.node_id = n.node_id AND m.run_id = $3
          )
        )
      ORDER BY (n.ref = $2) DESC, n.node_id ASC`,
    [input.projectId, input.branch, input.runId],
  );
  return result.rows;
}

/** Replace the authoritative member rows for a node (same transaction as the node UPSERT). */
export async function replaceIntegrationNodeMembers(
  client: QueryRunner,
  input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    members: ReadonlyArray<IntegrationNodeMember>;
  },
): Promise<void> {
  await client.query(`DELETE FROM integration_node_members WHERE node_id = $1`, [input.nodeId]);
  for (const [ordinal, member] of input.members.entries()) {
    await client.query(
      `INSERT INTO integration_node_members
         (org_id, project_id, node_id, ordinal, spec_id, run_id, branch, head_sha, included)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [input.orgId, input.projectId, input.nodeId, ordinal, member.specId, member.runId, member.branch, member.headSha],
    );
  }
}

/**
 * Load the authoritative ordered member vector, rejecting any JSON/row/key
 * divergence. Callers that need fail-closed land/materialization MUST use this
 * rather than trusting `members` jsonb alone.
 */
export async function loadAuthoritativeMembers(
  client: QueryRunner,
  input: { nodeId: string; baseSha: string; memberKey: string; membersJson: unknown },
): Promise<ReadonlyArray<IntegrationNodeMember>> {
  const jsonMembers = decodeMembersStrict(input.membersJson, input.nodeId);
  const result = await client.query<MemberRow>(
    `SELECT ordinal, spec_id, run_id, branch, head_sha, included
       FROM integration_node_members
      WHERE node_id = $1
      ORDER BY ordinal ASC`,
    [input.nodeId],
  );
  const rowMembers: IntegrationNodeMember[] = result.rows
    .filter((row) => row.included)
    .map((row) => ({
      specId: row.spec_id,
      runId: row.run_id,
      branch: row.branch,
      headSha: row.head_sha,
    }));

  // Empty member vectors are legal (non-speculative node against main). Both sides
  // must agree, including the stored member_key.
  if (!sameOrderedMembers(rowMembers, jsonMembers)) {
    throw new MemberLineageDivergenceError(
      input.nodeId,
      "normalized rows and members jsonb are not an exact ordered multiset match",
    );
  }
  const computed = memberKey(
    input.baseSha,
    rowMembers.map((m) => m.headSha),
  );
  if (computed !== input.memberKey) {
    throw new MemberLineageDivergenceError(
      input.nodeId,
      `stored member_key ${input.memberKey} != computed ${computed}`,
    );
  }
  // Ordinals must be dense 0..n-1 (no delete/reorder hole that still hashes equal).
  for (const [index, row] of result.rows.entries()) {
    if (row.ordinal !== index) {
      throw new MemberLineageDivergenceError(
        input.nodeId,
        `member ordinal gap or reorder at index ${index} (got ${row.ordinal})`,
      );
    }
  }
  return rowMembers;
}
