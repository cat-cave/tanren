// The pg-backed `integration_nodes` persistence model (tanren-owns-the-engine.md
// §3 — the ONE unified run model). Nodes are persisted only when their exact gate and
// policy content identities are known. Legacy run-row projections and empty identity
// defaults are deliberately absent: a consumer reads a real persisted node or none.
//
// Three responsibilities:
//   1. UPSERT a node + record/lookup a proof (insert/update + lookup by memberKey).
//   2. Read persisted eager-base nodes for the one base-shift consumer.
//
// Every tenant query is org-scoped (the run-create hook reuses the caller's already
// org-scoped client; the pool-based helpers open their OWN `runWithOrgScope`). RLS
// is fail-closed (migration 0007): a query off the scoped client sees ZERO rows.
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
import { requireCanonicalContentIdentity } from "../governance/policyGateIdentity.js";

/** Anything that can run a query — a pool or an already-checked-out scoped client. */
export type QueryRunner = Pick<pg.PoolClient, "query">;

/** The complete fields required to persist a proof-bindable integration node. */
export interface IntegrationNodeUpsert {
  projectId: string;
  orgId: string;
  baseBranch: string;
  baseSha: string;
  ref: string;
  purpose: IntegrationNodePurpose;
  /** The ordered members merged into the base (DAG order is LOAD-BEARING). */
  members: ReadonlyArray<IntegrationNodeMember>;
  /** Exact canonical hash used by this node's proof-reuse key. */
  gateConfigHash: string;
  /** Exact canonical governance-policy hash used by this node's proof-reuse key. */
  policyVersion: string;
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

/** Decode the persisted `members` jsonb into the typed ordered member array. */
function decodeMembers(value: unknown): IntegrationNodeMember[] {
  if (!Array.isArray(value)) return [];
  const out: IntegrationNodeMember[] = [];
  for (const m of value) {
    if (m === null || typeof m !== "object") continue;
    // Read each jsonb field through a Reflect probe (narrows off `object` without an
    // unsafe `as Record<…>` assertion); a non-string drops the member, fail-quiet on
    // a shape mismatch as before — this decode tolerates a partial/legacy member.
    const specId = Reflect.get(m, "specId");
    const runId = Reflect.get(m, "runId");
    const branch = Reflect.get(m, "branch");
    const headSha = Reflect.get(m, "headSha");
    if (
      typeof specId === "string" &&
      typeof runId === "string" &&
      typeof branch === "string" &&
      typeof headSha === "string"
    ) {
      out.push({ specId, runId, branch, headSha });
    }
  }
  return out;
}

/** Map a persisted row into the FROZEN `IntegrationNode` shape. */
function rowToNode(row: IntegrationNodeRow): IntegrationNode {
  return {
    nodeId: row.node_id,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    ref: row.ref,
    purpose: oneOf(row.purpose, INTEGRATION_NODE_PURPOSES, "integration_nodes.purpose"),
    members: decodeMembers(row.members),
    memberKey: row.member_key,
    gateConfigHash: requireCanonicalContentIdentity(row.gate_config_hash, "integration_nodes.gate_config_hash"),
    policyVersion: requireCanonicalContentIdentity(row.policy_version, "integration_nodes.policy_version"),
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
  // Validate before issuing SQL so no direct caller can reach the database with a
  // blank/schema-era/non-canonical identity. Both exact values are then written in
  // the SAME statement as the node (no display/proof-key split).
  const gateConfigHash = requireCanonicalContentIdentity(input.gateConfigHash, "gateConfigHash");
  const policyVersion = requireCanonicalContentIdentity(input.policyVersion, "policyVersion");
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
       affected_fingerprint = EXCLUDED.affected_fingerprint,
       head_sha = EXCLUDED.head_sha,
       tree_hash = EXCLUDED.tree_hash,
       status = EXCLUDED.status,
       updated_at = now()
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
      gateConfigHash,
      policyVersion,
      input.affectedFingerprint ?? "",
      input.headSha ?? null,
      input.treeHash ?? null,
      input.status ?? "building",
    ],
  );
  return result.rows[0]?.node_id ?? nodeId;
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

  /** Look up a node by its (org, member_key); `undefined` if none. */
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
      return row === undefined ? undefined : rowToNode(row);
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
   * Read the project's REAL persisted eager-base nodes. This deliberately does not
   * project legacy `runs.ancestor_stack` rows: a base-shift consumer sees the canonical
   * node store, including the exact gate/policy identities, or no node at all.
   */
  async findEagerBaseNodes(projectId: string): Promise<IntegrationNode[]> {
    const orgId = await this.resolveOrgOrThrow(projectId);
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<IntegrationNodeRow>(
        `SELECT node_id, base_branch, base_sha, ref, purpose, members, member_key,
                gate_config_hash, policy_version, affected_fingerprint, head_sha,
                tree_hash, status
           FROM integration_nodes
          WHERE project_id = $1 AND purpose = 'eager_base'
          ORDER BY updated_at DESC, node_id`,
        [projectId],
      );
      return result.rows.map((row) => rowToNode(row));
    });
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
      throw new Error(`project ${projectId} has no org for the integration-node store`);
    }
    return orgId;
  }
}
