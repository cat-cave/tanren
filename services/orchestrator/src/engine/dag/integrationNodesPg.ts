// §3 — the ONE unified run model). gv-17 promotes this from observe-only JSON to
// authoritative lineage: every UPSERT dual-writes ordered `integration_node_members`
// rows, computes `member_key` from those rows, and reads reject JSON/row divergence.
//
// Three responsibilities:
//   1. UPSERT a node + dual-write ordered members + record/lookup a proof.
//   2. The compatibility READ-MODEL: project an existing run row into the FROZEN
//      `IntegrationNode` shape — so a reader can see the OLD run model AS the new
//      one without a backfill, the explicit-read-model half of the §8 guardrail.
//   3. The OBSERVE-ONLY hook (`observeRunAsIntegrationNode`): an additive,
//      try/catch-wrapped UPSERT the run-create path calls so a node-write bug can
//      NEVER fail a run (no reads drive behavior).
//
// org-scoped client; the pool-based helpers open their OWN `runWithOrgScope`). RLS
// is fail-closed (FORCE + org policy): a query off the scoped client sees ZERO rows.
// Missing-org is a LOUD throw — NEVER an empty-on-missing-org fallback.

import { randomUUID } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  type IntegrationNode,
  type IntegrationNodeMember,
  type IntegrationNodePurpose,
  type IntegrationNodeStatus,
  INTEGRATION_NODE_PURPOSES,
  INTEGRATION_NODE_STATUSES,
  memberKey,
  type ProofReuseKeyInput,
  proofReuseKey,
} from "../contracts/integrationNodes.js";
import { oneOf } from "../data/pgRows.js";
import { resolveAncestorStack } from "./ancestorStack.js";
import {
  loadAuthoritativeMembers,
  MemberLineageDivergenceError,
  replaceIntegrationNodeMembers,
  selectNodesForDependentRun,
} from "./integrationNodeLineage.js";
import { speculativeRunToNode } from "./integrationNodeCompat.js";

/** Anything that can run a query — a pool or an already-checked-out scoped client. */
export type QueryRunner = Pick<pg.PoolClient, "query">;

export { MemberLineageDivergenceError };

/** The fields the run-create hook supplies to UPSERT a node (observe-only). */
export interface IntegrationNodeUpsert {
  projectId: string;
  orgId: string;
  baseBranch: string;
  baseSha: string;
  ref: string;
  purpose: IntegrationNodePurpose;
  /** The ordered members merged into the base (DAG order is LOAD-BEARING). */
  members: ReadonlyArray<IntegrationNodeMember>;
  gateConfigHash?: string;
  policyVersion?: string;
  affectedFingerprint?: string;
  headSha?: string;
  treeHash?: string;
  status?: IntegrationNodeStatus;
}

/** A persisted `integration_nodes` row (snake_case as it comes off pg). */
interface IntegrationNodeRow {
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

/** Map a persisted row + authoritative members into the FROZEN `IntegrationNode` shape. */
function rowToNode(row: IntegrationNodeRow, members: ReadonlyArray<IntegrationNodeMember>): IntegrationNode {
  return {
    nodeId: row.node_id,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    ref: row.ref,
    purpose: oneOf(row.purpose, INTEGRATION_NODE_PURPOSES, "integration_nodes.purpose"),
    members,
    memberKey: row.member_key,
    gateConfigHash: row.gate_config_hash,
    policyVersion: row.policy_version,
    affectedFingerprint: row.affected_fingerprint,
    ...(row.head_sha !== null && { headSha: row.head_sha }),
    ...(row.tree_hash !== null && { treeHash: row.tree_hash }),
    status: oneOf(row.status, INTEGRATION_NODE_STATUSES, "integration_nodes.status"),
  };
}

/**
 * UPSERT an integration node on an ALREADY org-scoped client. The
 * (org_id, member_key) unique index is the idempotency boundary: a re-walk of the
 * same base + ordered members refreshes the existing node (members/ref/status/head
 * re-stamped, `updated_at` bumped) rather than duplicating it. The `member_key` is
 * computed from the pure `memberKey(baseSha, ordered member shas)` — never trusted
 * from the caller. Returns the node id.
 */
export async function upsertIntegrationNodeOnClient(
  client: QueryRunner,
  input: IntegrationNodeUpsert,
): Promise<string> {
  // member_key is computed from ordered head SHAs — never trusted from the caller.
  const orderedShas = input.members.map((m) => m.headSha);
  const key = memberKey(input.baseSha, orderedShas);
  const nodeId = `inode_${randomUUID()}`;
  const result = await client.query<{ node_id: string }>(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members,
        member_key, gate_config_hash, policy_version, affected_fingerprint,
        head_sha, tree_hash, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT (org_id, member_key) DO UPDATE SET
       base_branch = EXCLUDED.base_branch,
       ref = EXCLUDED.ref,
       purpose = EXCLUDED.purpose,
       members = EXCLUDED.members,
       gate_config_hash = EXCLUDED.gate_config_hash,
       policy_version = EXCLUDED.policy_version,
       affected_fingerprint = CASE
         WHEN EXCLUDED.affected_fingerprint <> '' THEN EXCLUDED.affected_fingerprint
         WHEN integration_nodes.project_id = EXCLUDED.project_id
          AND integration_nodes.base_sha = EXCLUDED.base_sha
          AND integration_nodes.member_key = EXCLUDED.member_key
          AND integration_nodes.head_sha IS NOT DISTINCT FROM EXCLUDED.head_sha
          AND integration_nodes.tree_hash IS NOT DISTINCT FROM EXCLUDED.tree_hash
           THEN integration_nodes.affected_fingerprint
         ELSE ''
       END,
       head_sha = EXCLUDED.head_sha,
       tree_hash = EXCLUDED.tree_hash,
       status = EXCLUDED.status,
       updated_at = now()
     WHERE integration_nodes.project_id = EXCLUDED.project_id
     RETURNING node_id`,
    [
      nodeId,
      input.projectId,
      input.orgId,
      input.baseBranch,
      input.baseSha,
      input.ref,
      input.purpose,
      JSON.stringify(input.members),
      key,
      input.gateConfigHash ?? "",
      input.policyVersion ?? "",
      input.affectedFingerprint ?? "",
      input.headSha ?? null,
      input.treeHash ?? null,
      input.status ?? "building",
    ],
  );
  const persistedNodeId = result.rows[0]?.node_id;
  if (persistedNodeId === undefined) {
    throw new Error(`integration node member identity collides outside project ${input.projectId}`);
  }
  // Authoritative member vector: dual-write rows, then re-read to reject any
  // mid-write divergence before the outer transaction commits.
  await replaceIntegrationNodeMembers(client, {
    orgId: input.orgId,
    projectId: input.projectId,
    nodeId: persistedNodeId,
    members: input.members,
  });
  await loadAuthoritativeMembers(client, {
    nodeId: persistedNodeId,
    baseSha: input.baseSha,
    memberKey: key,
    membersJson: input.members,
  });
  return persistedNodeId;
}

/**
 * The pg-backed `integration_nodes` model. Pool-based helpers open their own
 * `runWithOrgScope`; the run-create hook uses {@link upsertIntegrationNodeOnClient}
 * on its in-tx scoped client. Missing-org is a LOUD throw (no fallback).
 */
export class PgIntegrationNodeModel {
  constructor(private readonly pool: pg.Pool) {}

  /** UPSERT a node under its org scope. Returns the node id. */
  async upsertNode(input: IntegrationNodeUpsert): Promise<string> {
    return runWithOrgScope(this.pool, input.orgId, (client) => upsertIntegrationNodeOnClient(client, input));
  }

  /**
   * Look up a node by its (org, member_key); `undefined` if none.
   * Fail-closed: JSON/row/member_key divergence throws {@link MemberLineageDivergenceError}
   * so land revalidation cannot treat a tampered vector as ready.
   */
  async findByMemberKey(orgId: string, key: string): Promise<IntegrationNode | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<IntegrationNodeRow>(
        `SELECT node_id, base_branch, base_sha, ref, purpose, members, member_key,
                gate_config_hash, policy_version, affected_fingerprint, head_sha,
                tree_hash, status
           FROM integration_nodes
          WHERE member_key = $1`,
        [key],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : rowToNode(
            row,
            await loadAuthoritativeMembers(client, {
              nodeId: row.node_id,
              baseSha: row.base_sha,
              memberKey: row.member_key,
              membersJson: row.members,
            }),
          );
    });
  }

  /**
   * Authoritative nodes for a base-shift dependent (member participation or branch ref).
   * Fail-closed via {@link loadAuthoritativeMembers}.
   */
  async findNodesForDependentRun(input: {
    orgId: string;
    projectId: string;
    runId: string;
    branch: string;
  }): Promise<IntegrationNode[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const rows = await selectNodesForDependentRun(client, input);
      const out: IntegrationNode[] = [];
      for (const row of rows) {
        const members = await loadAuthoritativeMembers(client, {
          nodeId: row.node_id,
          baseSha: row.base_sha,
          memberKey: row.member_key,
          membersJson: row.members,
        });
        out.push(rowToNode(row, members));
      }
      return out;
    });
  }

  /**
   * Look up a node by id under org scope. Same fail-closed lineage check as
   * {@link findByMemberKey}.
   */
  async findByNodeId(orgId: string, nodeId: string): Promise<IntegrationNode | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<IntegrationNodeRow>(
        `SELECT node_id, base_branch, base_sha, ref, purpose, members, member_key,
                gate_config_hash, policy_version, affected_fingerprint, head_sha,
                tree_hash, status
           FROM integration_nodes
          WHERE node_id = $1`,
        [nodeId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : rowToNode(
            row,
            await loadAuthoritativeMembers(client, {
              nodeId: row.node_id,
              baseSha: row.base_sha,
              memberKey: row.member_key,
              membersJson: row.members,
            }),
          );
    });
  }

  /**
   * Record a gate/CI proof on a node, keyed by the FULL `proofReuseKey` (the six
   * inputs). The (org, proof_reuse_key) unique index is the reuse boundary — the
   * same content+config+image+env+quarantine is one proof per org (re-record
   * refreshes the verdict/evidence). Returns the proof's reuse key.
   */
  async recordProof(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    keyInput: ProofReuseKeyInput;
    verdict: string;
    evidence?: unknown;
  }): Promise<string> {
    const key = proofReuseKey(input.keyInput);
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await client.query(
        `INSERT INTO integration_proofs
           (proof_id, project_id, org_id, node_id, proof_reuse_key, verdict, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (org_id, proof_reuse_key) DO UPDATE SET
           verdict = EXCLUDED.verdict,
           evidence = EXCLUDED.evidence`,
        [
          `proof_${randomUUID()}`,
          input.projectId,
          input.orgId,
          input.nodeId,
          key,
          input.verdict,
          JSON.stringify(input.evidence ?? {}),
        ],
      );
    });
    return key;
  }

  /** Look up a reusable proof by its full reuse key; `undefined` (cache MISS) if none. */
  async findProof(orgId: string, reuseKey: string): Promise<{ nodeId: string; verdict: string } | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ node_id: string; verdict: string }>(
        `SELECT node_id, verdict FROM integration_proofs WHERE proof_reuse_key = $1`,
        [reuseKey],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { nodeId: row.node_id, verdict: row.verdict };
    });
  }

  /**
   * The COMPATIBILITY READ-MODEL (§8 guardrail). Project a project's in-flight SPECULATIVE /
   * percolation run rows (the jj-native `runs.ancestor_stack` model) into the FROZEN
   * `IntegrationNode` shape — so the S0 base-shift node read sees the run model AS the node
   * model. READ-ONLY: it derives nodes, it does NOT persist them. A run is speculative iff
   * its `ancestor_stack` is non-empty.
   *
   * A speculative run row maps to a node:
   *   - `members`          = the ordered `ancestor_stack` (each `{specId, runId, branch, headSha}`).
   *   - `baseBranch`/`ref` = the immediate-ancestor PR-head branch (the stacked base), or the
   *                          dependent's own run branch when the stack carries no branch.
   *   - `purpose`          = `eager_base` (a speculative dependent's dynamic base).
   * Org-scoped under RLS; missing-org is a LOUD throw.
   */
  async projectSpeculativeRunsAsNodes(projectId: string): Promise<IntegrationNode[]> {
    const orgId = await this.resolveOrgOrThrow(projectId);
    const rows = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ run_id: string; spec_id: string; branch: string; ancestor_stack: unknown }>(
        `SELECT DISTINCT ON (r.spec_id)
                r.run_id, r.spec_id, r.branch, r.ancestor_stack
           FROM runs r
          WHERE r.project_id = $1
            AND jsonb_typeof(r.ancestor_stack) = 'array' AND jsonb_array_length(r.ancestor_stack) > 0
            AND r.status NOT IN ('halted','cancelled','failed','merged')
          ORDER BY r.spec_id, r.started_at DESC`,
        [projectId],
      );
      return result.rows;
    });
    return rows.map((row) =>
      speculativeRunToNode({
        runId: row.run_id,
        branch: row.branch,
        ancestorStack: resolveAncestorStack({ ancestorStack: row.ancestor_stack }),
      }),
    );
  }

  /** Resolve a project's org via the system scope; throw LOUDLY if it has none. */
  private async resolveOrgOrThrow(projectId: string): Promise<string> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      throw new Error(`project ${projectId} has no org for the integration-node read model`);
    }
    return orgId;
  }
}
