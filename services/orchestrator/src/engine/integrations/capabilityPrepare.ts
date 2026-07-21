// in-9 + in-10 (fused) — the `capability_prepare` DAG driver.
//
// in-9: MATERIALIZE a `capability_nodes` graph from a project's active integration
// requirements (one node per prepare-environment), then ENQUEUE provider
// preparation work onto the `integration_reconciliations` queue for every node
// whose dependencies and required grant are present.
//
// in-10: RESOLVE `capability_node_dependencies` (fail-closed on an unresolved
// parent) and PARK a grant-absent node as `awaiting_grant`; a grant-wake advances
// the parked node idempotently once the grant arrives.
//
// PRODUCTION INVOCATION: `prepare(projectId)` is the DagWalker's INTEGRATION PHASE —
// it runs on every walk of an ACTIVE project (the walk fires on the deriving→active
// activation wake, on every later DAG notification, and on the subscriber's periodic
// re-walk). Because that pass re-evaluates the `awaiting_grant` set on every tick, the
// grant-wake is genuinely live and reconciler-driven: once a grant arrives, the next
// walk advances the now-satisfied node. `wakeForGrant` is the same seam exposed for a
// prompt, provider-targeted wake (called by a product-grant-selection writer, and for
// direct proof).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  allowedProviders,
  capabilityDesiredStateHash,
  evaluateAndApply,
  type CapabilityEvalOutcome,
  type CapabilityNodeForEval,
  type QueryRunner,
} from "./capabilityNodeCore.js";

/** Only reversible, pre-merge environments are prepared eagerly; production is post-merge. */
const PREPARE_ENVIRONMENTS = new Set(["test", "preview"]);

export interface CapabilityPrepareSummary {
  readonly projectId: string;
  readonly materialized: number;
  readonly enqueued: number;
  readonly awaitingGrant: number;
  readonly needsAttention: number;
  readonly blocked: number;
}

// The evaluable subset — nodes whose status the prepare pass may still move.
// `needs_attention` is INCLUDED so a DEP-caused failure re-evaluates when its parent
// recovers (finding-2); a genuine terminal failure (no dep edges) stays put, guarded
// inside evaluateAndApply. Exported so the in-6 activation gate (`activate`)
// reuses the SAME mutable set when it evaluates the capability graph.
export const MUTABLE_STATUSES = ["pending", "awaiting_grant", "needs_attention"] as const;

interface RequirementRow {
  id: string;
  desired_state: unknown;
  source_digest: string;
}

interface CapabilityNodeRow {
  id: string;
  project_id: string;
  requirement_id: string;
  environment: string;
  status: string;
  generation: number;
  desired_state_hash: string;
  plane: string;
  capability: string;
  desired_state: unknown;
}

/**
 * The DagWalker integration-phase driver. Pool-injected (mirrors
 * `PgIntegrationNodeModel`); resolves a project's org under the system scope, then
 * does all tenant work inside ONE `runWithOrgScope` transaction so a node's status
 * transition, its reconciliation enqueue, and its lifecycle event commit together.
 */
export class CapabilityPrepareDriver {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The DagWalker INTEGRATION PHASE: materialize the capability graph from active
   * requirements, then evaluate every non-terminal node (in-9 enqueue + in-10 dep
   * resolution + awaiting_grant parking). Idempotent — safe to run on every walk.
   */
  async prepare(projectId: string): Promise<CapabilityPrepareSummary> {
    const orgId = await this.resolveOrgOrThrow(projectId);
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const materialized = await materializeCapabilityNodes(client, orgId, projectId);
      const tally = await evaluateNodes(client, orgId, projectId, MUTABLE_STATUSES);
      return { projectId, materialized, ...tally };
    });
  }

  /**
   * The in-10 GRANT-WAKE: re-evaluate the project's `awaiting_grant` nodes (narrowed
   * to those whose requirement admits `providerKind`, when given) and advance any
   * now-satisfied node to `enqueued` + enqueue its work. Fail-closed (re-checks the
   * grant per node) and idempotent (a second wake is a no-op). Callable directly for
   * a prompt wake; the walk's `prepare` pass is the always-on backstop.
   */
  async wakeForGrant(orgId: string, projectId: string, providerKind?: string): Promise<number> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const tally = await evaluateNodes(client, orgId, projectId, ["awaiting_grant"], providerKind);
      return tally.enqueued;
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
      throw new Error(`project ${projectId} has no org for capability_prepare`);
    }
    return orgId;
  }
}

/**
 * Materialize `capability_nodes` (in-9) from the project's ACTIVE integration
 * requirements. One node per prepare-environment (`test`/`preview`) the requirement
 * declares. Idempotent via the `(org_id, requirement_id, environment, generation)`
 * unique index — re-running never duplicates. Returns the count INSERTED this pass.
 */
export async function materializeCapabilityNodes(
  client: QueryRunner,
  orgId: string,
  projectId: string,
): Promise<number> {
  const requirements = await client.query<RequirementRow>(
    `SELECT id, desired_state, source_digest
       FROM integration_requirements
      WHERE org_id = $1 AND project_id = $2 AND status = 'active'`,
    [orgId, projectId],
  );
  let inserted = 0;
  for (const req of requirements.rows) {
    const environments = requirementEnvironments(req.desired_state);
    for (const environment of environments) {
      const desiredStateHash = capabilityDesiredStateHash({
        requirementId: req.id,
        environment,
        requirementSourceDigest: req.source_digest,
      });
      const result = await client.query(
        `INSERT INTO capability_nodes
           (org_id, id, project_id, requirement_id, environment, executor_kind,
            desired_state_hash, status, priority, generation)
         VALUES ($1, $2, $3, $4, $5, 'provider_operation', $6, 'pending', 0, 1)
         ON CONFLICT (org_id, requirement_id, environment, generation) DO NOTHING`,
        [orgId, `capnode_${req.id}_${environment}`, projectId, req.id, environment, desiredStateHash],
      );
      inserted += result.rowCount ?? 0;
    }
  }
  return inserted;
}

/** Load + evaluate the requested status set, tallying the applied outcomes. */
export async function evaluateNodes(
  client: QueryRunner,
  orgId: string,
  projectId: string,
  statuses: readonly string[],
  providerKind?: string,
): Promise<{ enqueued: number; awaitingGrant: number; needsAttention: number; blocked: number }> {
  const rows = await client.query<CapabilityNodeRow>(
    `SELECT n.id, n.project_id, n.requirement_id, n.environment, n.status, n.generation,
            n.desired_state_hash, r.plane, r.capability, r.desired_state
       FROM capability_nodes n
       JOIN integration_requirements r
         ON r.org_id = n.org_id AND r.project_id = n.project_id AND r.id = n.requirement_id
      WHERE n.org_id = $1 AND n.project_id = $2 AND n.status = ANY($3::text[])
        AND r.status = 'active'
      ORDER BY n.priority DESC, n.id`,
    [orgId, projectId, [...statuses]],
  );
  const tally = { enqueued: 0, awaitingGrant: 0, needsAttention: 0, blocked: 0 };
  for (const row of rows.rows) {
    const node: CapabilityNodeForEval = {
      id: row.id,
      projectId: row.project_id,
      requirementId: row.requirement_id,
      environment: row.environment,
      status: row.status,
      generation: row.generation,
      desiredStateHash: row.desired_state_hash,
      plane: row.plane,
      capability: row.capability,
      desiredState: row.desired_state,
    };
    // Provider-targeted wake: skip a parked node whose requirement cannot use the
    // arrived provider (a cheap in-memory filter; correctness is still the per-node
    // grant re-check inside evaluateAndApply).
    if (providerKind !== undefined && !allowedProviders(node.desiredState).includes(providerKind)) {
      continue;
    }
    const outcome = await evaluateAndApply(client, orgId, node);
    countOutcome(tally, outcome);
  }
  return tally;
}

function countOutcome(
  tally: { enqueued: number; awaitingGrant: number; needsAttention: number; blocked: number },
  outcome: CapabilityEvalOutcome,
): void {
  switch (outcome) {
    case "enqueued":
      tally.enqueued += 1;
      break;
    case "awaiting_grant":
      tally.awaitingGrant += 1;
      break;
    case "needs_attention":
      tally.needsAttention += 1;
      break;
    case "blocked":
      tally.blocked += 1;
      break;
    case "unchanged":
      break;
  }
}

function requirementEnvironments(desiredState: unknown): string[] {
  const obj =
    desiredState !== null && typeof desiredState === "object" ? (desiredState as Record<string, unknown>) : {};
  const envs = obj["environments"];
  if (!Array.isArray(envs)) return [];
  return envs.filter((e): e is string => typeof e === "string" && PREPARE_ENVIRONMENTS.has(e));
}
