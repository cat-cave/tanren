import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { findLatestPreMergeBehaviorRun } from "../../merge/behaviorLandGate.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

export type AcceptanceCompletenessFailure =
  | "missing_release_binding"
  | "missing_required_behaviors"
  | "missing_or_ambiguous_acceptance_run"
  | "plan_set_mismatch"
  | "verdict_set_mismatch"
  | "required_verdict_not_passed"
  | "required_verdict_unexecuted"
  | "gate_proof_artifact_mismatch"
  | "ci_compat_projection_missing";

export type AcceptanceCompletenessResult =
  | { readonly complete: true; readonly kind: "not_applicable" }
  | {
      readonly complete: true;
      readonly kind: "complete";
      readonly runId: string;
      readonly requiredBehaviorRevisionCount: number;
    }
  | { readonly complete: false; readonly failure: AcceptanceCompletenessFailure };

export interface AcceptanceCompletenessInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly releaseInstanceId: string;
  /** The exact digest that the coordinator is about to record as promoted. */
  readonly promotedArtifactDigest: string;
}

/**
 * The promotion-time behavior-completeness invariant. This deliberately reads first-class release,
 * plan, and verdict facts; `ci_test_results` is only the final compatibility
 * projection and cannot rescue a missing behavior proof.
 */
export class PgAcceptanceCompletenessChecker {
  private readonly withOrgScope: OrgScope;

  public constructor(pool: pg.Pool, withOrgScope?: OrgScope) {
    this.withOrgScope = withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  public async check(input: AcceptanceCompletenessInput): Promise<AcceptanceCompletenessResult> {
    requireText(input.orgId, "orgId");
    requireText(input.projectId, "projectId");
    requireText(input.releaseInstanceId, "releaseInstanceId");
    requireText(input.promotedArtifactDigest, "promotedArtifactDigest");
    return this.withOrgScope(input.orgId, (client) => checkInScope(client, input));
  }
}

export async function checkInScope(
  client: QueryClient,
  input: AcceptanceCompletenessInput,
): Promise<AcceptanceCompletenessResult> {
  // Deploy-on-merge binds production `release_instances.integration_node_id` directly
  // to the merge `runId` (not an `integration_nodes.node_id`). Reuse the exact
  // behavior-land requirement predicate over that key; a missing release/binding is
  // ambiguous and therefore blocks, while only a definite absence of that pre-merge
  // binding may skip completeness.
  const releaseRows = await client.query<{ integration_node_id: unknown }>(
    `SELECT integration_node_id
       FROM release_instances
      WHERE org_id = $1 AND project_id = $2 AND id = $3 AND artifact_digest = $4`,
    [input.orgId, input.projectId, input.releaseInstanceId, input.promotedArtifactDigest],
  );
  const release = releaseRows.rows[0];
  if (release === undefined || typeof release.integration_node_id !== "string" || release.integration_node_id === "") {
    return { complete: false, failure: "missing_release_binding" };
  }
  const preMergeRun = await findLatestPreMergeBehaviorRun(client, input.orgId, release.integration_node_id);
  if (preMergeRun === undefined) return { complete: true, kind: "not_applicable" };

  const requiredRows = await client.query<{ behavior_revision_id: unknown }>(
    `SELECT rb.behavior_revision_id
       FROM release_instances ri
       JOIN release_instance_behavior_revisions rb
         ON rb.org_id = ri.org_id AND rb.release_instance_id = ri.id
      WHERE ri.org_id = $1 AND ri.project_id = $2 AND ri.id = $3
        AND ri.integration_node_id IS NOT NULL AND ri.artifact_digest = $4
      ORDER BY rb.ordinal ASC`,
    [input.orgId, input.projectId, input.releaseInstanceId, input.promotedArtifactDigest],
  );
  const required = strings(requiredRows.rows.map((row) => row.behavior_revision_id));
  if (required.length === 0 || new Set(required).size !== required.length) {
    return { complete: false, failure: "missing_required_behaviors" };
  }

  const runs = await client.query<{ id: unknown }>(
    `SELECT r.id
       FROM behavior_verification_runs r
       JOIN release_instances ri ON ri.org_id = r.org_id
      WHERE r.org_id = $1 AND r.project_id = $2 AND ri.id = $3
        AND r.purpose = 'post_merge_production' AND r.status = 'completed'
        AND r.integration_node_id = ri.integration_node_id AND r.artifact_digest = ri.artifact_digest`,
    [input.orgId, input.projectId, input.releaseInstanceId],
  );
  if (runs.rows.length !== 1) return { complete: false, failure: "missing_or_ambiguous_acceptance_run" };
  const runId = oneText(runs.rows[0]?.id, "behavior_verification_runs.id");

  const planRows = await client.query<{ behavior_revision_id: unknown }>(
    `SELECT p.behavior_revision_id
       FROM behavior_verification_attempts a
       JOIN behavior_verification_plans p ON p.org_id = a.org_id AND p.id = a.plan_id
      WHERE a.org_id = $1 AND a.run_id = $2`,
    [input.orgId, runId],
  );
  if (!sameExactSet(required, strings(planRows.rows.map((row) => row.behavior_revision_id)))) {
    return { complete: false, failure: "plan_set_mismatch" };
  }

  const verdictRows = await client.query<{
    behavior_revision_id: unknown;
    outcome: unknown;
    executed_assertion_count: unknown;
  }>(
    `SELECT behavior_revision_id, outcome, executed_assertion_count
       FROM behavior_verdicts
      WHERE org_id = $1 AND run_id = $2`,
    [input.orgId, runId],
  );
  const verdictIds = strings(verdictRows.rows.map((row) => row.behavior_revision_id));
  if (!sameExactSet(required, verdictIds) || new Set(verdictIds).size !== verdictIds.length) {
    return { complete: false, failure: "verdict_set_mismatch" };
  }
  for (const verdict of verdictRows.rows) {
    if (verdict.outcome !== "passed") return { complete: false, failure: "required_verdict_not_passed" };
    if (!positiveInt(verdict.executed_assertion_count)) {
      return { complete: false, failure: "required_verdict_unexecuted" };
    }
  }

  const proof = await client.query<{ count: unknown }>(
    `SELECT COUNT(*)::int AS count
       FROM gate_proof_bundles g
       JOIN proof_bundles b ON b.org_id = g.org_id AND b.id = g.proof_bundle_id
       JOIN release_instances ri ON ri.org_id = g.org_id
      WHERE g.org_id = $1 AND g.project_id = $2 AND ri.id = $3
        AND g.integration_node_id = ri.integration_node_id AND g.gate_verdict = 'passed'
        AND b.artifact_digest = ri.artifact_digest AND b.artifact_digest = $4`,
    [input.orgId, input.projectId, input.releaseInstanceId, input.promotedArtifactDigest],
  );
  if (integer(proof.rows[0]?.count) !== 1) return { complete: false, failure: "gate_proof_artifact_mismatch" };

  const ci = await client.query<{ count: unknown }>(
    `SELECT COUNT(*)::int AS count
       FROM ci_test_results c
       JOIN integration_nodes n ON n.org_id = c.org_id AND n.project_id = c.project_id
       JOIN release_instances ri ON ri.org_id = n.org_id AND ri.integration_node_id = n.node_id
      WHERE c.org_id = $1 AND c.project_id = $2 AND ri.id = $3
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(n.members) member
           WHERE member ->> 'runId' = c.run_id
        )`,
    [input.orgId, input.projectId, input.releaseInstanceId],
  );
  if (!positiveInt(ci.rows[0]?.count)) return { complete: false, failure: "ci_compat_projection_missing" };
  return { complete: true, kind: "complete", runId, requiredBehaviorRevisionCount: required.length };
}

function requireText(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must be a non-blank string`);
}
function oneText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be non-blank`);
  return value;
}
function strings(values: unknown[]): string[] {
  return values.map((value) => oneText(value, "database behavior revision id"));
}
function integer(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  throw new TypeError("database count must be an integer");
}
function positiveInt(value: unknown): boolean {
  try {
    return integer(value) > 0;
  } catch {
    return false;
  }
}
function sameExactSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((item) => right.includes(item)) && new Set(right).size === right.length
  );
}
