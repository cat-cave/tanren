// The pg-backed `integration_nodes` persistence model (tanren-owns-the-engine.md
// §3 — the ONE unified run model). Wave 2 / Slice S0 is OBSERVE-ONLY: this model is
// WRITTEN ALONGSIDE the existing `runs.speculative_base` + percolation columns and
// drives NO control flow. It exists so the never-discard rebase + the proof-reuse
// cache (Wave 3) have a durable substrate, and so the §8 guardrail holds — the old
// speculative/percolation state migrates through an EXPLICIT compatibility
// read-model (`projectRunRowToNode` below), never silent abandonment.
//
// Three responsibilities:
//   1. UPSERT a node + record/lookup a proof (insert/update + lookup by memberKey).
//   2. The compatibility READ-MODEL: project an existing `speculative_base` +
//      `integrated_ancestor_shas`/`verified_ancestor_shas` run row into the FROZEN
//      `IntegrationNode` shape — so a reader can see the OLD run model AS the new
//      one without a backfill, the explicit-read-model half of the §8 guardrail.
//   3. The OBSERVE-ONLY hook (`observeRunAsIntegrationNode`): an additive,
//      try/catch-wrapped UPSERT the run-create path calls so a node-write bug can
//      NEVER fail a run (no reads drive behavior).
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
  memberKey,
  type ProofReuseKeyInput,
  proofReuseKey,
} from "../contracts/integrationNodes.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("integration-nodes");

/** Anything that can run a query — a pool or an already-checked-out scoped client. */
export type QueryRunner = Pick<pg.PoolClient, "query">;

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

/** Decode the persisted `members` jsonb into the typed ordered member array. */
function decodeMembers(value: unknown): IntegrationNodeMember[] {
  if (!Array.isArray(value)) return [];
  const out: IntegrationNodeMember[] = [];
  for (const m of value) {
    if (m === null || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (
      typeof r["specId"] === "string" &&
      typeof r["runId"] === "string" &&
      typeof r["branch"] === "string" &&
      typeof r["headSha"] === "string"
    ) {
      out.push({ specId: r["specId"], runId: r["runId"], branch: r["branch"], headSha: r["headSha"] });
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
    purpose: row.purpose as IntegrationNodePurpose,
    members: decodeMembers(row.members),
    memberKey: row.member_key,
    gateConfigHash: row.gate_config_hash,
    policyVersion: row.policy_version,
    affectedFingerprint: row.affected_fingerprint,
    ...(row.head_sha !== null && { headSha: row.head_sha }),
    ...(row.tree_hash !== null && { treeHash: row.tree_hash }),
    status: row.status as IntegrationNodeStatus,
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
      input.gateConfigHash ?? "",
      input.policyVersion ?? "",
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
   * The COMPATIBILITY READ-MODEL (§8 guardrail). Project a project's in-flight
   * SPECULATIVE / percolation run rows (the OLD `speculative_base` +
   * `integrated_ancestor_shas` model) into the FROZEN `IntegrationNode` shape —
   * WITHOUT a backfill, so a reader sees the old run model AS the new one. This is
   * the explicit-read-model migration path, never silent abandonment. READ-ONLY:
   * it derives nodes, it does NOT persist them.
   *
   * A speculative run row maps to a node:
   *   - `baseBranch`/`ref` = the run's `speculative_base` (the dynamic base).
   *   - `baseSha`          = the base identity. The old run row never persisted the
   *                          `main` SHA, so the base ref string is the best available
   *                          base identity (the Wave-3 materialization records the
   *                          real SHA). Honest about what the old model carried.
   *   - `members`          = `integrated_ancestor_shas` (ancestorSpecId → headSha),
   *                          ORDERED by ancestor spec id (the old map is unordered;
   *                          a stable sort gives a deterministic key).
   *   - `purpose`          = `eager_base` (a speculative dependent's dynamic base).
   * Org-scoped under RLS; missing-org is a LOUD throw.
   */
  async projectSpeculativeRunsAsNodes(projectId: string): Promise<IntegrationNode[]> {
    const orgId = await this.resolveOrgOrThrow(projectId);
    const rows = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        run_id: string;
        spec_id: string;
        branch: string;
        speculative_base: string | null;
        integrated_ancestor_shas: unknown;
      }>(
        `SELECT DISTINCT ON (r.spec_id)
                r.run_id, r.spec_id, r.branch, r.speculative_base, r.integrated_ancestor_shas
           FROM runs r
          WHERE r.project_id = $1
            AND r.speculative_base IS NOT NULL
            AND r.status NOT IN ('halted','cancelled','failed','merged')
          ORDER BY r.spec_id, r.started_at DESC`,
        [projectId],
      );
      return result.rows;
    });
    return rows.map((row) =>
      speculativeRunToNode({
        runId: row.run_id,
        specId: row.spec_id,
        branch: row.branch,
        speculativeBase: row.speculative_base ?? "",
        integratedAncestorShas: asShaMap(row.integrated_ancestor_shas),
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

/**
 * The OBSERVE-ONLY write hook the run-create path calls. Given the run being
 * inserted (on its already org-scoped, in-tx client), ADDITIVELY UPSERT the
 * `integration_nodes` row that mirrors it — derived from the SAME speculative base
 * + ancestor head SHAs the run row records, via the pure `memberKey`. A
 * non-speculative run (no base, no ancestors) is a node with ZERO members — still a
 * node (the unified model: one run, base may shift), so it is recorded too.
 *
 * SAVEPOINT-ISOLATED so it can NEVER fail a run. This runs INSIDE the run-create
 * transaction, and in Postgres ANY statement error POISONS the whole tx ("current
 * transaction is aborted") — a bare try/catch does NOT save the subsequent
 * spec/task/job/event writes, which would then fail and FAIL THE RUN. So the observe
 * write is wrapped in a SAVEPOINT: on ANY error we `ROLLBACK TO SAVEPOINT` (which
 * un-poisons the tx back to the savepoint) and swallow it, leaving the outer tx
 * clean to commit the real run. No reads drive behavior; this is pure observation.
 *
 * The org is read back from the just-inserted run row on the SAME scoped client
 * (the INSERT derived `org_id` from the project) so the UPSERT carries the exact
 * tenant key. A null-org (CLI) run is SKIPPED (nothing to scope a tenant write to).
 */
export async function observeRunAsIntegrationNode(
  client: QueryRunner,
  // The structural shape of the run being inserted (a SpecRunContract — kept
  // structural to avoid coupling this dag module to the workflow types).
  run: { runId: string; specId: string; branch: string; projectId: string; project: { defaultBranch: string } },
  // The speculative block (`undefined` ⇒ a non-speculative run against `main`).
  spec: { speculativeBase: string | null; integratedAncestorShas?: Record<string, string> } | undefined,
): Promise<void> {
  // The SAVEPOINT is the un-poison boundary: any error inside the observe write
  // rolls the tx back to HERE, so the outer run-create tx stays committable.
  await client.query("SAVEPOINT obs_node");
  try {
    const orgResult = await client.query<{ org_id: string | null }>("SELECT org_id FROM runs WHERE run_id = $1", [
      run.runId,
    ]);
    const orgId = orgResult.rows[0]?.org_id ?? null;
    // A null-org (CLI) run has no tenant key to scope a write to — skip it (but still
    // RELEASE the savepoint below so the tx has no dangling savepoint).
    if (orgId !== null) {
      const speculativeBase = spec?.speculativeBase ?? null;
      const baseBranch = run.project.defaultBranch;
      // baseSha: the old run row never persists the `main` SHA, so the base identity
      // is the speculative base ref when speculative, else the default branch name (a
      // non-speculative run against `main`). Honest about what the run model carries;
      // the Wave-3 materialization records the real SHA.
      const baseSha = speculativeBase ?? baseBranch;
      const members = buildMembersFromAncestorShas(run.runId, spec?.integratedAncestorShas ?? {});
      await upsertIntegrationNodeOnClient(client, {
        projectId: run.projectId,
        orgId,
        baseBranch,
        baseSha,
        ref: speculativeBase ?? run.branch,
        // eager dependent's dynamic base when speculative; else a (zero-member) node
        // against `main`. The purpose only LABELS intent — it never branches control.
        purpose: "eager_base",
        members,
        status: "building",
      });
    }
    // Success (or a benign null-org skip): RELEASE the savepoint, keeping the node
    // write part of the outer tx's commit.
    await client.query("RELEASE SAVEPOINT obs_node");
  } catch (error) {
    // OBSERVE-ONLY: a node-write failure must NEVER fail a run. ROLLBACK TO the
    // savepoint FIRST — this un-poisons the aborted tx so the run-create's remaining
    // writes succeed — then RELEASE it and swallow the error. The ROLLBACK is the
    // load-bearing fix; the log is for visibility.
    await client.query("ROLLBACK TO SAVEPOINT obs_node").catch(() => {});
    await client.query("RELEASE SAVEPOINT obs_node").catch(() => {});
    log.warn("observe-only node UPSERT failed (non-fatal)", { runId: run.runId }, error);
  }
}

/**
 * Build the ordered members from the run's `integrated_ancestor_shas` (ancestor
 * spec id → head SHA). ORDERED by ancestor spec id (the map is unordered) so the
 * `memberKey` is deterministic. The dependent's own run id labels the integration;
 * the ancestor branch is unknown on the run row (Wave-3 resolves it) so the ancestor
 * spec id is the stable branch placeholder (a total, never-partial member).
 */
function buildMembersFromAncestorShas(runId: string, shas: Record<string, string>): IntegrationNodeMember[] {
  return Object.entries(shas)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ancestorSpecId, headSha]) => ({ specId: ancestorSpecId, runId, branch: ancestorSpecId, headSha }));
}

/** Coerce a persisted jsonb blob into the per-ancestor SHA map (string→string only). */
export function asShaMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * PURE: project ONE old speculative run row into the FROZEN `IntegrationNode`
 * shape (the §8 compatibility read-model, factored out so it is unit-testable
 * WITHOUT a DB). The ancestor SHA map is ORDERED by ancestor spec id (the old map
 * is unordered) → a stable, deterministic `memberKey`.
 */
export function speculativeRunToNode(input: {
  runId: string;
  specId: string;
  branch: string;
  speculativeBase: string;
  integratedAncestorShas: Record<string, string>;
}): IntegrationNode {
  const orderedAncestors = Object.entries(input.integratedAncestorShas).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const members: IntegrationNodeMember[] = orderedAncestors.map(([ancestorSpecId, headSha]) => ({
    specId: ancestorSpecId,
    // The old run row carries only the ancestor's spec id + head SHA on the
    // dependent; its run id/branch are not on this row. The dependent's own run id
    // labels the integration; the ancestor branch is unknown here (Wave-3
    // materialization resolves it). Use the ancestor spec id as a stable branch
    // placeholder so the projection is total (never a partial/empty member).
    runId: input.runId,
    branch: ancestorSpecId,
    headSha,
  }));
  const baseSha = input.speculativeBase;
  return {
    nodeId: `inode_compat_${input.runId}`,
    baseBranch: input.speculativeBase,
    baseSha,
    ref: input.speculativeBase,
    purpose: "eager_base",
    members,
    memberKey: memberKey(
      baseSha,
      members.map((m) => m.headSha),
    ),
    gateConfigHash: "",
    policyVersion: "",
    affectedFingerprint: "",
    status: "building",
  };
}
