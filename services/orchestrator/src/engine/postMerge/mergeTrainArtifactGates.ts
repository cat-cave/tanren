// cspell:ignore multiset
// mq-15 pure, DB-free fail-closed gates. The watcher is a thin DB shell over these
// functions: every fail-closed DECISION (a mismatched land group, cross-project decision,
// stale receipt, wrong group-formed, partial/reordered/non-landed member set, SHA-unbound
// or failed terminal deploy/demo) is made here over already-fetched rows, so every
// negative control is asserted without a database. The seal itself lives in the sibling
// `mergeTrainArtifactSeal.ts`.

import type pg from "pg";
import { z } from "zod";
import { canonicalJson, contentDigestOf, type Digest } from "../contracts/cas.js";
import type { MergeTrainMember } from "../contracts/mergeTrainArtifact.js";
import type { ValidatedRunLineage } from "./runLineage.js";

export type QueryClient = Pick<pg.PoolClient, "query">;

export const CompletedPayload = z
  .object({
    projectId: z.string().min(1),
    landGroupId: z.string().min(1),
    decisionId: z.string().min(1),
    expectedMainSha: z.string().min(1),
    authorizedSha: z.string().min(1),
    mainSha: z.string().min(1),
    memberKeys: z.array(z.string().min(1)).min(1),
  })
  .strip();
export type CompletedData = z.infer<typeof CompletedPayload>;

const GroupFormedPayload = z
  .object({ groupId: z.string().min(1), memberKeys: z.array(z.string().min(1)).min(1) })
  .strip();
const ProofRootComposedPayload = z
  .object({ integrationNodeId: z.string().min(1), proofRoot: z.string().min(1) })
  .strip();
const DeployVerifiedPayload = z
  .object({
    provider: z.string().min(1),
    appId: z.string().min(1),
    deploymentId: z.string().min(1),
    url: z.string().min(1),
    state: z.string().min(1),
  })
  .strip();
export type DeployData = z.infer<typeof DeployVerifiedPayload>;
const DemoCompletedPayload = z
  .object({
    surfaceKind: z.string().min(1),
    behaviorCount: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  })
  .strip();
export type DemoData = z.infer<typeof DemoCompletedPayload>;

interface DecisionRow {
  readonly project_id: string;
  readonly integration_node_id: string;
  readonly proof_root: string;
  readonly head_sha: string;
  readonly expected_main_sha: string;
  readonly member_set_hash: string;
}
interface GroupRow {
  readonly state: string;
  readonly main_sha: string | null;
  readonly decision_id: string;
  readonly created_at: Date | string;
}
interface MemberRow {
  readonly member_key: string;
  readonly run_id: string | null;
  readonly spec_id: string | null;
  readonly pr_number: string | null;
  readonly outcome: string | null;
}

interface ReleaseRow {
  readonly source_ref: string;
  readonly state: string;
}

/** Release states that are NOT a live delivery of the sealed tip (fail-closed). */
const DEAD_RELEASE_STATES = new Set(["failed", "rolled_back", "torn_down", "superseded"]);

/** Everything the seal needs, gathered under one org-scoped read. Absent ⇒ no-op. */
export interface Evidence {
  readonly lineage: ValidatedRunLineage;
  readonly completed: CompletedData;
  readonly decision: DecisionRow;
  readonly issuedAt: string;
  readonly receiptAuditId: string;
  readonly receiptMainSha: string;
  readonly members: MergeTrainMember[];
  readonly deploy: DeployData;
  readonly demo: DemoData;
}

// ---- Fail-closed gates (each returns false/undefined on ANY mismatch) --------------

export function landGroupSatisfies(group: GroupRow | undefined, completed: CompletedData): group is GroupRow {
  return (
    group !== undefined &&
    group.state === "completed" &&
    group.main_sha === completed.mainSha &&
    group.decision_id === completed.decisionId
  );
}

export function decisionSatisfies(
  decision: DecisionRow | undefined,
  completed: CompletedData,
  projectId: string,
): decision is DecisionRow {
  // Cross-project fail-closed: the decision must belong to THIS project, AND its
  // authorized head + expected-main base must EXACTLY match the completed land — a
  // decision authorizing a DIFFERENT head SHA than the one that landed is rejected.
  return (
    decision !== undefined &&
    decision.project_id === projectId &&
    decision.expected_main_sha === completed.expectedMainSha &&
    decision.head_sha === completed.authorizedSha
  );
}

export function demoIsSuccessful(demo: DemoData): boolean {
  return demo.behaviorCount > 0 && demo.failed === 0 && demo.passed === demo.behaviorCount;
}

/** A deterministic content digest over the CANONICAL (sorted) member-key set. */
export function memberSetDigest(memberKeys: readonly string[]): Digest {
  return contentDigestOf(new TextEncoder().encode(canonicalJson([...memberKeys].sort())));
}

/** EXACT multiset equality (order-insensitive, duplicate-sensitive). */
function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Resolve the land group's members with EXACT-SET enforcement — the gravest fail-open
 * here is sealing a partial/reordered/foreign-member train as a full delivery. It fails
 * closed unless the durable `land_group_members` set is EXACTLY the completed +
 * group.formed member sets (same count, no missing, no extra), EVERY member is
 * `outcome='landed'`, and every member has durable run identity. Order is CANONICALIZED
 * (sorted by member key), so a reordered payload yields the identical artifact rather
 * than a divergent one.
 */
export function resolveExactMembers(input: {
  rows: readonly MemberRow[];
  completedKeys: readonly string[];
  formedKeys: readonly string[];
}): MergeTrainMember[] | undefined {
  const tableKeys = input.rows.map((row) => row.member_key);
  // Exact set equality across all three durable sources (table / completed / formed).
  if (!sameMultiset(tableKeys, input.completedKeys)) return undefined;
  if (!sameMultiset(input.formedKeys, input.completedKeys)) return undefined;
  // The recomputed member-set digest must agree across every source.
  const digest = memberSetDigest(tableKeys);
  if (memberSetDigest(input.completedKeys) !== digest || memberSetDigest(input.formedKeys) !== digest) return undefined;
  // Every member must have LANDED and carry durable run identity.
  if (input.rows.some((row) => row.outcome !== "landed" || row.run_id === null || row.spec_id === null)) {
    return undefined;
  }
  return [...input.rows]
    .sort((left, right) => left.member_key.localeCompare(right.member_key))
    .map((row, ordinal) => {
      const prNumber = row.pr_number === null ? null : Number.parseInt(row.pr_number, 10);
      return {
        ordinal,
        memberKey: row.member_key,
        runId: row.run_id!,
        specId: row.spec_id!,
        prNumber: prNumber === null || Number.isNaN(prNumber) ? null : prNumber,
      };
    });
}

/** The release for this deployment must exist, be alive, and be FOR the sealed tip. */
export function releaseBindsToLand(release: ReleaseRow | undefined, completed: CompletedData): release is ReleaseRow {
  return (
    release !== undefined &&
    !DEAD_RELEASE_STATES.has(release.state) &&
    (release.source_ref === completed.mainSha || release.source_ref === completed.authorizedSha)
  );
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The single newest TERMINAL event of a family for the run (verified vs failed). */
async function newestTerminalEvent(
  client: QueryClient,
  orgId: string,
  runId: string,
  eventTypes: readonly string[],
): Promise<{ event_type: string; payload: unknown } | undefined> {
  const result = await client.query<{ event_type: string; payload: unknown }>(
    `SELECT event_type, payload FROM events
       WHERE org_id = $1 AND run_id = $2 AND event_type = ANY($3::text[])
       ORDER BY ts DESC, id DESC LIMIT 1`,
    [orgId, runId, [...eventTypes]],
  );
  return result.rows[0];
}

/**
 * Read + gate every bound input on an already-org-scoped client. Exercised in a unit
 * test with a stub `{ query }`; the negative controls all resolve to `undefined` here.
 *
 * The terminal deploy/demo evidence is resolved as the NEWEST TERMINAL event of its
 * family (`deploy.verified` vs `deploy.failed`; `demo.completed` vs `demo.failed`), so a
 * prior success followed by a later failure of the tip fails closed. The deploy is bound
 * to the sealed tip through `release_instances` (its `source_ref` must be the land's main
 * or authorized SHA and the release must not be dead) — a stale success for a prior SHA
 * on the same run does NOT satisfy the gate.
 */
export async function gatherEvidenceFromClient(
  client: QueryClient,
  lineage: ValidatedRunLineage,
  completed: CompletedData,
  runId: string,
): Promise<Evidence | undefined> {
  const group = (
    await client.query<GroupRow>(
      "SELECT state, main_sha, decision_id, created_at FROM land_groups WHERE org_id = $1 AND id = $2",
      [lineage.orgId, completed.landGroupId],
    )
  ).rows[0];
  if (!landGroupSatisfies(group, completed)) return undefined;

  const decision = (
    await client.query<DecisionRow>(
      `SELECT project_id, integration_node_id, proof_root, head_sha, expected_main_sha, member_set_hash
         FROM authority_decisions WHERE org_id = $1 AND id = $2`,
      [lineage.orgId, completed.decisionId],
    )
  ).rows[0];
  if (!decisionSatisfies(decision, completed, lineage.projectId)) return undefined;

  const receipt = (
    await client.query<{ audit_id: string; main_sha: string }>(
      "SELECT audit_id, main_sha FROM authority_land_receipts WHERE org_id = $1 AND effect_intent_id = $2",
      [lineage.orgId, `land-group-${completed.landGroupId}`],
    )
  ).rows[0];
  if (receipt === undefined || receipt.main_sha !== group.main_sha) return undefined;

  const formedEvent = await newestTerminalEvent(client, lineage.orgId, runId, ["merge.group.formed"]);
  const formed = formedEvent === undefined ? undefined : GroupFormedPayload.safeParse(formedEvent.payload);
  if (formed === undefined || !formed.success || formed.data.groupId !== completed.landGroupId) return undefined;

  const proofComposed = (
    await client.query<{ payload: unknown }>(
      `SELECT payload FROM events
         WHERE org_id = $1 AND project_id = $2 AND event_type = 'integration.proof_root.composed'
           AND payload->>'proofRoot' = $3 AND payload->>'integrationNodeId' = $4
         ORDER BY ts DESC, id DESC LIMIT 1`,
      [lineage.orgId, lineage.projectId, decision.proof_root, decision.integration_node_id],
    )
  ).rows[0];
  if (proofComposed === undefined || !ProofRootComposedPayload.safeParse(proofComposed.payload).success)
    return undefined;

  const memberRows = (
    await client.query<MemberRow>(
      "SELECT member_key, run_id, spec_id, pr_number, outcome FROM land_group_members WHERE org_id = $1 AND land_group_id = $2",
      [lineage.orgId, completed.landGroupId],
    )
  ).rows;
  const members = resolveExactMembers({
    rows: memberRows,
    completedKeys: completed.memberKeys,
    formedKeys: formed.data.memberKeys,
  });
  if (members === undefined) return undefined;

  // Deploy: the NEWEST terminal deploy event must be a verification (not a later failure).
  const deployEvent = await newestTerminalEvent(client, lineage.orgId, runId, ["deploy.verified", "deploy.failed"]);
  if (deployEvent === undefined || deployEvent.event_type !== "deploy.verified") return undefined;
  const deploy = DeployVerifiedPayload.safeParse(deployEvent.payload);
  if (!deploy.success) return undefined;
  // Bind the deploy to the sealed tip via its release_instances row.
  const release = (
    await client.query<ReleaseRow>(
      `SELECT source_ref, state FROM release_instances
         WHERE org_id = $1 AND deployment_id = $2
         ORDER BY created_at DESC LIMIT 1`,
      [lineage.orgId, deploy.data.deploymentId],
    )
  ).rows[0];
  if (!releaseBindsToLand(release, completed)) return undefined;

  // Demo: the NEWEST terminal demo event must be a completion (not a later failure) and full pass.
  const demoEvent = await newestTerminalEvent(client, lineage.orgId, runId, ["demo.completed", "demo.failed"]);
  if (demoEvent === undefined || demoEvent.event_type !== "demo.completed") return undefined;
  const demo = DemoCompletedPayload.safeParse(demoEvent.payload);
  if (!demo.success || !demoIsSuccessful(demo.data)) return undefined;

  return {
    lineage,
    completed,
    decision,
    issuedAt: iso(group.created_at),
    receiptAuditId: receipt.audit_id,
    receiptMainSha: receipt.main_sha,
    members,
    deploy: deploy.data,
    demo: demo.data,
  };
}
