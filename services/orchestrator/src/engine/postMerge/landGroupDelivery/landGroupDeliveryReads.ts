// mq-13 DB reads for the land-group delivery loop, split out so the loop shell stays under
// the line cap and the SQL lives in one place. Two responsibilities:
//   • resolveCompletedGroup — detect that `runId` is the TAIL run of a COMPLETED land group
//     (it carries `merge.land_group.completed`), re-verify the durable `land_groups` row is
//     `completed` with the payload's main SHA + decision, verify project ownership through the
//     authority decision (land_groups has NO project_id), and resolve the ordered member run
//     ids. Fail-closed to `undefined` on any mismatch (a merely-formed group, a cross-project
//     decision, a partial/unlanded member set).
//   • isLandGroupMember — the MEMBERSHIP GUARD the in-17 per-run delivery driver consults so a
//     group member's per-run deploy/demo NO-OPS (the group deploys ONCE, not once per member).
//
// All reads are read-only + carry no secret material. The completed-event read runs under the
// de-privileged system scope (to resolve org ownership); the durable-row gates run under the
// run's org scope (RLS-enforced).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  CompletedPayload,
  type CompletedData,
  landGroupSatisfies,
  decisionSatisfies,
} from "../mergeTrainArtifactGates.js";
import { loadValidatedRunEvent, type ValidatedRunLineage } from "../runLineage.js";
import { repoSlugFromPrUrl } from "../deployOnMergeReads.js";
import {
  type DeployTargetResolution,
  grantsSignalDeployIntent,
  resolveDeployTarget,
} from "../deployTargetResolution.js";
import { IntegrationConnectionsStore } from "../../repositories/integrationConnections.js";
import type { GroupDeliveryPlan } from "./groupDeliveryCore.js";

type ReadClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The detected completed group: the delivery plan + the merged repo slug + the run lineage. */
export interface GroupDetection {
  readonly plan: GroupDeliveryPlan;
  /** The merged repo slug (`owner/name`) the group artifact is built from (from the tail PR URL). */
  readonly repoSlug: string;
  readonly lineage: ValidatedRunLineage;
}

interface GroupRow {
  readonly state: string;
  readonly main_sha: string | null;
  readonly decision_id: string;
  readonly created_at: Date | string;
}
interface DecisionRow {
  readonly project_id: string;
  readonly integration_node_id: string;
  readonly proof_root: string;
  readonly head_sha: string;
  readonly expected_main_sha: string;
  readonly member_set_hash: string;
}
interface MemberRow {
  readonly member_key: string;
  readonly run_id: string | null;
  readonly spec_id: string | null;
  readonly outcome: string | null;
}

/**
 * Detect + resolve a COMPLETED land group from its tail run. Returns undefined when `runId`
 * is not a completed-group tail (no `merge.land_group.completed`), the durable `land_groups`
 * row is not `completed`/mismatched, the authority decision does not belong to the run's
 * project, the PR URL yields no repo slug, or the member set is not fully landed with run ids.
 */
export async function resolveCompletedGroup(pool: pg.Pool, runId: string): Promise<GroupDetection | undefined> {
  // 1. The completed event lives ONLY on the tail run. Resolve org ownership under system scope.
  const completedEvent = await runWithSystemScope(pool, (client) =>
    loadValidatedRunEvent(client, { runId, eventType: "merge.land_group.completed", requireEventSpec: false }),
  );
  if (completedEvent === undefined) return undefined;
  const parsed = CompletedPayload.safeParse(completedEvent.payload);
  if (!parsed.success) return undefined;
  const completed = parsed.data;
  const lineage = completedEvent.lineage;
  // The payload's projectId must equal the run-lineage project (cross-project fail-closed).
  if (completed.projectId !== lineage.projectId) return undefined;
  if (completedEvent.prUrl === null) return undefined;
  const repoSlug = repoSlugFromPrUrl(completedEvent.prUrl);
  if (repoSlug === undefined) return undefined;

  // 2. Gate the durable rows under the run's org scope (RLS-enforced).
  return runWithOrgScope(pool, lineage.orgId, async (client): Promise<GroupDetection | undefined> => {
    const group = (
      await client.query<GroupRow>(
        "SELECT state, main_sha, decision_id, created_at FROM land_groups WHERE org_id = $1 AND id = $2",
        [lineage.orgId, completed.landGroupId],
      )
    ).rows[0];
    if (!landGroupSatisfies(group, completed)) return undefined;

    // Project ownership is verified through the authority decision (land_groups has no project_id).
    const decision = (
      await client.query<DecisionRow>(
        `SELECT project_id, integration_node_id, proof_root, head_sha, expected_main_sha, member_set_hash
           FROM authority_decisions WHERE org_id = $1 AND id = $2`,
        [lineage.orgId, completed.decisionId],
      )
    ).rows[0];
    if (!decisionSatisfies(decision, completed, lineage.projectId)) return undefined;

    const members = await resolveOrderedMembers(client, lineage.orgId, completed);
    if (members === undefined) return undefined;

    const plan: GroupDeliveryPlan = {
      orgId: lineage.orgId,
      projectId: lineage.projectId,
      landGroupId: completed.landGroupId,
      mainSha: completed.mainSha,
      tailRunId: lineage.runId,
      tailSpecId: lineage.specId,
      memberRunIds: members.runIds,
      memberSpecIds: members.specIds,
    };
    return { plan, repoSlug, lineage } satisfies GroupDetection;
  });
}

/**
 * Resolve the ordered member run ids for a completed group. Canonical order = `land_group_members`
 * sorted by `member_key` (the same ordinal order the merge-train artifact uses). Fail-closed to
 * undefined unless the member-key set EXACTLY equals the completed payload's `memberKeys` and
 * EVERY member is `outcome='landed'` with a non-blank run id (a partial/unlanded set is rejected
 * before any deploy — the same exact-set discipline as `resolveExactMembers`).
 */
async function resolveOrderedMembers(
  client: ReadClient,
  orgId: string,
  completed: CompletedData,
): Promise<{ runIds: string[]; specIds: string[] } | undefined> {
  const rows = (
    await client.query<MemberRow>(
      "SELECT member_key, run_id, spec_id, outcome FROM land_group_members WHERE org_id = $1 AND land_group_id = $2",
      [orgId, completed.landGroupId],
    )
  ).rows;
  if (rows.length === 0) return undefined;
  const tableKeys = rows.map((row) => row.member_key).sort();
  const completedKeys = [...completed.memberKeys].sort();
  if (tableKeys.length !== completedKeys.length) return undefined;
  if (!tableKeys.every((key, index) => key === completedKeys[index])) return undefined;
  const ordered = [...rows].sort((left, right) => left.member_key.localeCompare(right.member_key));
  const runIds: string[] = [];
  const specIds: string[] = [];
  for (const row of ordered) {
    if (row.outcome !== "landed") return undefined;
    if (typeof row.run_id !== "string" || row.run_id.trim() === "") return undefined;
    if (typeof row.spec_id !== "string" || row.spec_id.trim() === "") return undefined;
    runIds.push(row.run_id);
    specIds.push(row.spec_id);
  }
  return { runIds, specIds };
}

/**
 * Resolve the completed group's PROJECT deploy intent (system-scoped) into the THREE-WAY
 * {@link DeployTargetResolution} — the SAME resolution the per-run deploy watcher uses
 * (`resolveDeployTarget` over the project config + a deploy-intent probe of the org's control
 * grants). A `configured` result carries the provider + appId the group artifact deploys onto;
 * `none`/`incomplete` mean the group has no resolvable deploy target (the loop no-ops — mq-15
 * would not seal a non-deployed group either).
 */
export async function resolveGroupDeployTarget(
  pool: pg.Pool,
  lineage: ValidatedRunLineage,
): Promise<DeployTargetResolution> {
  return runWithSystemScope(pool, async (client) => {
    const row = (
      await client.query<{ config: unknown; org_id: string | null }>(
        "SELECT config, org_id FROM projects WHERE project_id = $1 AND org_id = $2",
        [lineage.projectId, lineage.orgId],
      )
    ).rows[0];
    if (row === undefined || row.org_id !== lineage.orgId) return { kind: "none" };
    const config =
      row.config !== null && typeof row.config === "object" && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {};
    const grants = await IntegrationConnectionsStore.listExactControlGrants(client, lineage.orgId);
    return resolveDeployTarget({
      orgId: lineage.orgId,
      config,
      deployIntent: grantsSignalDeployIntent(
        grants.map((grant) => ({ providerKind: grant.providerKind, capabilities: grant.capabilities })),
      ),
    });
  });
}

/**
 * THE MEMBERSHIP GUARD. Whether `runId` is a member of a COMPLETED land group — the guard the
 * in-17 per-run delivery driver consults so a group member's per-run deploy/demo NO-OPS (the
 * group loop owns the ONE group-level delivery).
 *
 * SCOPED TO `completed` (Finding 3): the LandGroupDeliveryLoop ONLY delivers COMPLETED groups
 * (it activates on `merge.land_group.completed`). A member of a formed/failed/partial group is
 * NOT delivered by the loop, so it must KEEP its normal per-run delivery — suppressing it would
 * strand that member with zero delivery forever. So this returns true ONLY when the run's group
 * is `completed` (the exact state set the loop handles). A solo (non-group) run, or a member of
 * a non-completed group, returns false and keeps its per-run delivery.
 */
export async function isLandGroupMember(client: ReadClient, orgId: string, runId: string): Promise<boolean> {
  const result = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM land_group_members m
       JOIN land_groups g ON g.org_id = m.org_id AND g.id = m.land_group_id
      WHERE m.org_id = $1 AND m.run_id = $2 AND g.state = 'completed'
      LIMIT 1`,
    [orgId, runId],
  );
  return result.rows[0] !== undefined;
}
