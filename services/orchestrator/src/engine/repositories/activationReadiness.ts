// in-6: the integration activation-readiness gate.
//
// A pure predicate + scoped query that decides whether a project's REQUIRED
// integration capabilities are prepared enough for the project to promote
// `deriving → active`. Composed onto `ProjectDerivationStore.activate` ALONGSIDE
// the existing `assertProjectDerivationActivationEvidence` (derivation receipts)
// — it does NOT replace it. A project reaches `active` ONLY when BOTH pass.
//
// ACTIVATION-REQUIRED vs OPTIONAL (the in-5 `criticality` contract):
//   `merge_required` + `release_required` → ACTIVATION-REQUIRED (the product
//   genuinely depends on them; an un-ready one blocks activation).
//   `best_effort` → OPTIONAL (never blocks; satisfied post-activation).
//
// PASS vs BLOCK (allow-list, trap #8 — never a deny-list):
//   `enqueued` (grant present, work queued) + `ready` (fully prepared) → PASS.
//   Everything else — `pending`, `awaiting_grant`, `needs_attention`, AND any
//   UNKNOWN status → BLOCK (fail-closed; trap #4 vacuous-truth + trap #8).
//
// PROOF = EFFECT (trap #7): the gate reads the EXACT `capability_nodes` rows for
// the project's required set (joined to `integration_requirements` for
// criticality), on the SAME scoped client `activate` holds its `FOR UPDATE` lock
// on. No pre-computed verdict, no coordinate divergence.
//
// FAIL-CLOSED on a MATERIALIZATION GAP: if a required requirement exists but NO
// capability_node has been materialized for it, the gate BLOCKS (never vacuously
// passes on the empty set — trap #4). The caller (`activate`) runs
// `materializeCapabilityNodes` + `evaluateNodes` immediately before this check so
// the gap only arises from a genuine bug (a loud block, not a silent skip).

import type pg from "pg";
import { evaluateNodes, materializeCapabilityNodes, MUTABLE_STATUSES } from "../integrations/capabilityPrepare.js";

/**
 * The criticality values that make an integration capability ACTIVATION-REQUIRED.
 * A `best_effort` capability is optional — it never blocks activation (in-6 must
 * NOT over-gate on non-required capabilities, per acceptance criterion 3).
 */
export const ACTIVATION_REQUIRED_CRITICALITIES = ["merge_required", "release_required"] as const;

/**
 * The capability-node statuses that PASS the activation gate. An allow-list
 * (trap #8): only these statuses pass; every other value — including an UNKNOWN
 * one — blocks. `enqueued` = grant present + provider work queued (the
 * reconciliation saga will prepare it); `ready` = fully prepared. Both prove the
 * grant is genuinely present (grantCovers passed inside `evaluateAndApply`).
 */
export const ACTIVATION_PASS_STATUSES = ["enqueued", "ready"] as const;

/** A required capability node's gate-relevant fields (the join of node + requirement). */
export interface CapabilityReadinessRow {
  readonly requirementId: string;
  readonly capability: string;
  readonly criticality: string;
  readonly status: string;
  readonly waitReason: string | null;
}

/** A required requirement that has NO materialized capability node (a materialization gap). */
export interface MaterializationGapRow {
  readonly requirementId: string;
  readonly capability: string;
  readonly criticality: string;
}

/**
 * The activation-readiness verdict — pure data so it's testable without a DB and
 * serializable into the typed block error + the readiness-blocked event.
 */
export interface ActivationReadinessVerdict {
  readonly ready: boolean;
  readonly blockers: ReadonlyArray<{
    readonly requirementId: string;
    readonly capability: string;
    readonly criticality: string;
    readonly status: string;
    readonly waitReason: string | null;
  }>;
  readonly gaps: ReadonlyArray<{
    readonly requirementId: string;
    readonly capability: string;
    readonly criticality: string;
  }>;
}

/** True iff the criticality makes the requirement activation-required (allow-list). */
export function isActivationRequiredCriticality(criticality: string): boolean {
  return (ACTIVATION_REQUIRED_CRITICALITIES as readonly string[]).includes(criticality);
}

/** True iff the node status passes the activation gate (allow-list; unknown → false). */
export function isActivationPassStatus(status: string): boolean {
  return (ACTIVATION_PASS_STATUSES as readonly string[]).includes(status);
}

/**
 * The PURE predicate — evaluates a project's activation readiness from its
 * required-capability node rows + any materialization gaps. Fail-closed on
 * unknown status (trap #8), empty-set (trap #4), and missing materialization.
 *
 * `rows` is the FULL set of capability_nodes joined to their requirements (the
 * caller loads them scoped). `gaps` is the set of required requirements that have
 * NO node materialized yet (the caller loads them on the same scope). Both come
 * from the SAME locked client so the verdict reflects a consistent snapshot.
 */
export function evaluateActivationReadiness(
  rows: ReadonlyArray<CapabilityReadinessRow>,
  gaps: ReadonlyArray<MaterializationGapRow> = [],
): ActivationReadinessVerdict {
  const blockers = rows
    .filter((row) => isActivationRequiredCriticality(row.criticality))
    .filter((row) => !isActivationPassStatus(row.status));
  const requiredGaps = gaps.filter((gap) => isActivationRequiredCriticality(gap.criticality));
  return {
    ready: blockers.length === 0 && requiredGaps.length === 0,
    blockers,
    gaps: requiredGaps,
  };
}

/**
 * Thrown by `assertIntegrationActivationReadiness` when a project cannot activate
 * because one or more REQUIRED integration capabilities are un-ready. The project
 * stays `deriving` (activate's `lifecycle='deriving'` WHERE clause is never
 * reached). Carries the typed blockers + gaps so the caller (the derive saga /
 * the activation wake) can surface them on the derivation read surface and emit
 * the durable `project.activation.readiness_blocked` event.
 */
export class ProjectActivationReadinessBlockedError extends Error {
  override readonly name = "ProjectActivationReadinessBlockedError";

  constructor(
    readonly projectId: string,
    readonly verdict: ActivationReadinessVerdict,
  ) {
    const blockerSummary = verdict.blockers
      .map((b) => `${b.capability} (${b.status}${b.waitReason === null ? "" : `: ${b.waitReason}`})`)
      .join(", ");
    const gapSummary = verdict.gaps.map((g) => `${g.capability} (no capability node materialized)`).join(", ");
    const parts = [...(blockerSummary === "" ? [] : [blockerSummary]), ...(gapSummary === "" ? [] : [gapSummary])];
    super(
      `project ${projectId} cannot activate: required integration capability(ies) un-ready — ${parts.join("; ")}. ` +
        "The project stays 'deriving' until every required capability is granted/prepared (fail-closed).",
    );
  }
}

interface ReadinessQueryRow {
  requirement_id: string;
  capability: string;
  criticality: string;
  status: string;
  wait_reason: string | null;
}

interface GapQueryRow {
  requirement_id: string;
  capability: string;
  criticality: string;
}

/**
 * Load the capability-node readiness rows + any materialization gaps for a
 * project, on the caller's scoped client. Runs UNDER RLS: an off-scope client
 * sees ZERO rows (deny-by-default). The caller (activate) holds the `FOR UPDATE`
 * lock on the project row so this snapshot is consistent with the lifecycle CAS.
 *
 * Joining `capability_nodes` ↔ `integration_requirements` (status='active') gives
 * the per-node criticality that drives the required-vs-optional split. A node
 * whose requirement was superseded is excluded by `r.status = 'active'`.
 */
export async function loadActivationReadiness(
  client: Pick<pg.PoolClient, "query">,
  orgId: string,
  projectId: string,
): Promise<{ rows: CapabilityReadinessRow[]; gaps: MaterializationGapRow[] }> {
  const requiredList = [...ACTIVATION_REQUIRED_CRITICALITIES];
  const nodesResult = await client.query<ReadinessQueryRow>(
    `SELECT n.requirement_id, r.capability, r.criticality, n.status, n.wait_reason
       FROM capability_nodes n
       JOIN integration_requirements r
         ON r.org_id = n.org_id AND r.project_id = n.project_id AND r.id = n.requirement_id
      WHERE n.org_id = $1 AND n.project_id = $2 AND r.status = 'active'`,
    [orgId, projectId],
  );
  const gapsResult = await client.query<GapQueryRow>(
    `SELECT r.id AS requirement_id, r.capability, r.criticality
       FROM integration_requirements r
      WHERE r.org_id = $1 AND r.project_id = $2 AND r.status = 'active'
        AND r.criticality = ANY($3::text[])
        AND NOT EXISTS (
          SELECT 1 FROM capability_nodes n
           WHERE n.org_id = r.org_id AND n.project_id = r.project_id
             AND n.requirement_id = r.id
        )`,
    [orgId, projectId, requiredList],
  );
  return {
    rows: nodesResult.rows.map((row) => ({
      requirementId: row.requirement_id,
      capability: row.capability,
      criticality: row.criticality,
      status: row.status,
      waitReason: row.wait_reason,
    })),
    gaps: gapsResult.rows.map((row) => ({
      requirementId: row.requirement_id,
      capability: row.capability,
      criticality: row.criticality,
    })),
  };
}

/**
 * The activation gate assertion — composed onto `ProjectDerivationStore.activate`.
 * Loads the readiness state on the scoped locked client and throws
 * `ProjectActivationReadinessBlockedError` if any REQUIRED capability is un-ready
 * or missing. A no-op (passes) when the project has no activation-required
 * requirements at all (the legitimate "nothing to gate on" case — the gate
 * engages only when in-5 compiled requirements exist).
 */
export async function assertIntegrationActivationReadiness(
  client: Pick<pg.PoolClient, "query">,
  orgId: string,
  projectId: string,
): Promise<ActivationReadinessVerdict> {
  const { rows, gaps } = await loadActivationReadiness(client, orgId, projectId);
  const verdict = evaluateActivationReadiness(rows, gaps);
  if (!verdict.ready) {
    throw new ProjectActivationReadinessBlockedError(projectId, verdict);
  }
  return verdict;
}

/**
 * The in-6 readiness STAGE: materialize the capability graph from active
 * requirements, evaluate every mutable node (so a present grant advances it to
 * `enqueued` / `ready` here), then assert every REQUIRED capability is in a pass
 * status. Composed onto `activate`'s transaction — runs on the SAME locked
 * client so the verdict is consistent with the lifecycle CAS (proof = effect,
 * trap #7). Materialize + evaluate are idempotent (ON CONFLICT DO NOTHING /
 * applyStatus change-check), so re-running on a later grant-wake attempt is free.
 */
export async function prepareIntegrationReadiness(
  client: Pick<pg.PoolClient, "query">,
  orgId: string,
  projectId: string,
): Promise<ActivationReadinessVerdict> {
  await materializeCapabilityNodes(client, orgId, projectId);
  await evaluateNodes(client, orgId, projectId, MUTABLE_STATUSES);
  return assertIntegrationActivationReadiness(client, orgId, projectId);
}
