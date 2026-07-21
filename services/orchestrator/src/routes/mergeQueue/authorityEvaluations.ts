// cspell:ignore mqeval mqgrp
// MQ-2 read-only projection over durable W0 facts and exact SP-4 decisions.

import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { IntegrationNodeMember } from "../../engine/contracts/integrationNodes.js";
import { memberKey } from "../../engine/contracts/integrationNodes.js";
import { authorityDerivedId } from "../../engine/merge/authoritySignalIdentity.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import {
  exactBatchProofForNode,
  projectDurableSignals,
  readDurableBatchEvidence,
} from "./authorityEvaluationEvidence.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EvaluationId = z.string().regex(/^mqeval_[0-9a-f]{64}$/u);
const GroupId = z.string().regex(/^mqgrp_[0-9a-f]{64}$/u);

const AuthorityKind = z.enum([
  "authorized_subset",
  "member_failure",
  "interaction_failure",
  "flake_observation",
  "transient_infrastructure",
  "needs_product_decision",
  "unknown_fail_closed",
]);

const MemberOutcome = z
  .object({
    ordinal: z.number().int().nonnegative(),
    specId: z.string().min(1),
    runId: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    headSha: z.string().min(1).nullable(),
    disposition: z.enum(["admit", "exclude", "hold", "bisect"]),
    findingIds: z.array(z.string()),
    reasonCodes: z.array(z.string()),
  })
  .strict();

export const MergeQueueAuthorityEvaluationProjection = z
  .object({
    evaluationId: EvaluationId,
    groupId: GroupId,
    kind: AuthorityKind,
    observedAt: z.string().datetime({ offset: true }),
    source: z.enum(["merge.signal.classified", "authority_decision", "batch_gate", "quarantine"]),
    sourceId: z.string().min(1),
    nodeId: z.string().min(1).nullable(),
    memberSetHash: z.string().min(1).nullable(),
    proofReuseKey: z.string().min(1).nullable(),
    members: z.array(MemberOutcome),
    findingIds: z.array(z.string()),
    reasonCodes: z.array(z.string()),
    eligibleMemberIds: z.array(z.string()),
  })
  .strict();
export type MergeQueueAuthorityEvaluationProjection = z.infer<typeof MergeQueueAuthorityEvaluationProjection>;

const ListResponse = z
  .object({
    latestEvaluationId: EvaluationId.nullable(),
    evaluations: z.array(MergeQueueAuthorityEvaluationProjection),
  })
  .strict();
const DetailResponse = z.object({ evaluation: MergeQueueAuthorityEvaluationProjection }).strict();

interface EvaluationRoutesOptions {
  pool: pg.Pool;
}

interface SignalRow {
  event_id: string;
  ts: Date | string;
  payload: unknown;
}

interface DecisionRow {
  decision_id: string;
  created_at: Date | string;
  node_id: string;
  decision_head_sha: string;
  expected_main_sha: string;
  artifact_digest: string;
  proof_root: string;
  decision_member_set_hash: string;
  decision_policy_version: string;
  base_sha: string;
  node_head_sha: string | null;
  tree_hash: string | null;
  members: unknown;
  member_key: string;
  gate_config_hash: string;
  node_policy_version: string;
  proof_reuse_key: string;
  proof_evidence: unknown;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : undefined;
}

async function withProject<T>(input: {
  pool: pg.Pool;
  actor: ActorContext;
  orgId: string;
  projectId: string;
  read: (client: pg.PoolClient) => Promise<T>;
}): Promise<T | null> {
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    try {
      const project = await assertProjectAccess(client, input.projectId, input.actor);
      if (project.orgId !== input.orgId) return null;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return null;
      throw error;
    }
    return input.read(client);
  });
}

async function readSignals(
  client: pg.PoolClient,
  projectId: string,
  orgId: string,
  evaluationId: string | undefined,
  limit: number | undefined,
): Promise<SignalRow[]> {
  if (evaluationId !== undefined) {
    return (
      await client.query<SignalRow>(
        `SELECT id::text AS event_id, ts, payload
           FROM events
          WHERE project_id = $1 AND org_id = $2
            AND event_type = 'merge.signal.classified'
            AND payload->>'evaluationId' = $3
          ORDER BY id DESC`,
        [projectId, orgId, evaluationId],
      )
    ).rows;
  }
  return (
    await client.query<SignalRow>(
      `SELECT id::text AS event_id, ts, payload
         FROM events
        WHERE project_id = $1 AND org_id = $2
          AND event_type = 'merge.signal.classified'
        ORDER BY id DESC
        LIMIT $3`,
      [projectId, orgId, limit ?? DEFAULT_LIMIT],
    )
  ).rows;
}

async function readAuthorizedDecisions(
  client: pg.PoolClient,
  projectId: string,
  orgId: string,
  limit: number | undefined,
): Promise<DecisionRow[]> {
  const values: unknown[] = [projectId, orgId];
  const limitSql = limit === undefined ? "" : "LIMIT $3";
  if (limit !== undefined) values.push(limit);
  return (
    await client.query<DecisionRow>(
      `SELECT d.id AS decision_id, d.created_at, d.integration_node_id AS node_id,
              d.head_sha AS decision_head_sha, d.expected_main_sha, d.artifact_digest,
              d.proof_root, d.member_set_hash AS decision_member_set_hash,
              d.policy_version AS decision_policy_version, n.base_sha,
              n.head_sha AS node_head_sha, n.tree_hash, n.members, n.member_key,
              n.gate_config_hash, n.policy_version AS node_policy_version,
              p.proof_reuse_key, p.evidence AS proof_evidence
         FROM authority_decisions d
         JOIN integration_nodes n
           ON n.org_id = d.org_id AND n.project_id = d.project_id
          AND n.node_id = d.integration_node_id
         JOIN integration_proofs p
           ON p.org_id = d.org_id AND p.project_id = d.project_id
          AND p.node_id = n.node_id AND p.verdict = 'passed'
          AND ('sha256:' || p.proof_reuse_key) = d.proof_root
        WHERE d.project_id = $1 AND d.org_id = $2
          AND d.subject_kind = 'integration_node' AND d.decision = 'authorized'
          AND n.purpose = 'merge_batch'
        ORDER BY d.created_at DESC, d.id DESC
        ${limitSql}`,
      values,
    )
  ).rows;
}

function decisionProjection(row: DecisionRow): MergeQueueAuthorityEvaluationProjection | undefined {
  const members = decodeMembers(row.members);
  if (!exactAuthorizedDecision(row, members)) return undefined;
  const groupId = authorityDerivedId("mqgrp", {
    memberSetHash: row.member_key,
    members: members.map((member) => ({ runId: member.runId, specId: member.specId })),
    subject: { id: row.node_id, kind: "integration_node" },
  });
  const evaluationId = authorityDerivedId("mqeval", {
    decisionId: row.decision_id,
    durableSource: "authority_decision.v1",
    node: {
      artifactDigest: row.artifact_digest,
      baseSha: row.base_sha,
      headSha: row.node_head_sha!,
      id: row.node_id,
      memberSetHash: row.member_key,
      members: members.map((member) => ({
        branch: member.branch,
        headSha: member.headSha,
        runId: member.runId,
        specId: member.specId,
      })),
      policyVersion: row.node_policy_version,
      proofReuseKey: row.proof_reuse_key,
      treeHash: row.tree_hash!,
    },
  });
  return MergeQueueAuthorityEvaluationProjection.parse({
    evaluationId,
    groupId,
    kind: "authorized_subset",
    observedAt: iso(row.created_at),
    source: "authority_decision",
    sourceId: row.decision_id,
    nodeId: row.node_id,
    memberSetHash: row.member_key,
    proofReuseKey: row.proof_reuse_key,
    members: members.map((member, ordinal) => ({
      ordinal,
      ...member,
      disposition: "admit",
      findingIds: [],
      reasonCodes: [],
    })),
    findingIds: [],
    reasonCodes: [],
    eligibleMemberIds: members.map((member) => member.specId),
  });
}

function decodeMembers(value: unknown): IntegrationNodeMember[] {
  if (!Array.isArray(value)) return [];
  const members: IntegrationNodeMember[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object") return [];
    const specId = Reflect.get(candidate, "specId");
    const runId = Reflect.get(candidate, "runId");
    const branch = Reflect.get(candidate, "branch");
    const headSha = Reflect.get(candidate, "headSha");
    if (![specId, runId, branch, headSha].every((part) => typeof part === "string" && part.trim() !== "")) return [];
    members.push({ specId, runId, branch, headSha });
  }
  return members;
}

function exactAuthorizedDecision(row: DecisionRow, members: ReadonlyArray<IntegrationNodeMember>): boolean {
  if (members.length === 0 || row.node_head_sha === null || row.tree_hash === null) return false;
  const identities = members.map((member) => `${member.specId}\0${member.runId}`);
  return (
    new Set(identities).size === identities.length &&
    row.decision_head_sha === row.node_head_sha &&
    row.expected_main_sha === row.base_sha &&
    row.decision_member_set_hash === row.member_key &&
    row.member_key ===
      memberKey(
        row.base_sha,
        members.map((member) => member.headSha),
      ) &&
    row.decision_policy_version === row.node_policy_version &&
    row.proof_root === `sha256:${row.proof_reuse_key}` &&
    row.artifact_digest === artifactDigest(row.node_head_sha, row.tree_hash) &&
    exactBatchProofForNode(
      {
        nodeId: row.node_id,
        headSha: row.node_head_sha,
        treeHash: row.tree_hash,
        memberSetHash: row.member_key,
        gateConfigHash: row.gate_config_hash,
        policyVersion: row.node_policy_version,
        proofReuseKey: row.proof_reuse_key,
        proofEvidence: row.proof_evidence,
      },
      "passed",
    ) !== undefined
  );
}

function artifactDigest(headSha: string, treeHash: string): string {
  const hex = createHash("sha256")
    .update("tanren:merge-batch-artifact:v1\0")
    .update(headSha)
    .update("\0")
    .update(treeHash)
    .digest("hex");
  return `sha256:${hex}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function latestFirst(
  left: MergeQueueAuthorityEvaluationProjection,
  right: MergeQueueAuthorityEvaluationProjection,
): number {
  return right.observedAt.localeCompare(left.observedAt) || right.sourceId.localeCompare(left.sourceId);
}

async function readProjections(input: {
  pool: pg.Pool;
  actor: ActorContext;
  orgId: string;
  projectId: string;
  evaluationId?: string;
  limit?: number;
}): Promise<MergeQueueAuthorityEvaluationProjection[] | null> {
  return withProject({
    ...input,
    read: async (client) => {
      // One org-scoped transaction owns this client. Keep reads ordered: pg does not
      // support concurrent query execution on one checked-out client.
      const signalRows = await readSignals(client, input.projectId, input.orgId, input.evaluationId, input.limit);
      const signals = await projectDurableSignals(client, input.projectId, input.orgId, signalRows);
      const decisions = await readAuthorizedDecisions(
        client,
        input.projectId,
        input.orgId,
        input.evaluationId === undefined ? input.limit : undefined,
      );
      const evidence = await readDurableBatchEvidence(
        client,
        input.projectId,
        input.orgId,
        input.evaluationId === undefined ? input.limit : undefined,
      );
      const projected = [
        ...signals.map((projection) => MergeQueueAuthorityEvaluationProjection.parse(projection)),
        ...evidence.map((projection) => MergeQueueAuthorityEvaluationProjection.parse(projection)),
        ...decisions.flatMap((row) => {
          const projection = decisionProjection(row);
          return projection === undefined ? [] : [projection];
        }),
      ]
        .filter((projection) => input.evaluationId === undefined || projection.evaluationId === input.evaluationId)
        .sort(latestFirst);
      return input.limit === undefined ? projected : projected.slice(0, input.limit);
    },
  });
}

export function createMergeQueueAuthorityEvaluationRoutes(options: EvaluationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  app.get("/:orgId/projects/:projectId/merge-queue/authority-evaluations", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "merge_queue_evaluations_not_found" }, 404);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === undefined) return c.json({ error: "invalid_limit", min: 1, max: MAX_LIMIT }, 400);
    const evaluations = await readProjections({
      pool: options.pool,
      actor,
      orgId,
      projectId: c.req.param("projectId"),
      limit,
    });
    if (evaluations === null) return c.json({ error: "merge_queue_evaluations_not_found" }, 404);
    return c.json(ListResponse.parse({ latestEvaluationId: evaluations[0]?.evaluationId ?? null, evaluations }));
  });

  app.get("/:orgId/projects/:projectId/merge-queue/authority-evaluations/:evaluationId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "merge_queue_evaluation_not_found" }, 404);
    const evaluationId = c.req.param("evaluationId");
    if (!EvaluationId.safeParse(evaluationId).success)
      return c.json({ error: "merge_queue_evaluation_not_found" }, 404);
    const evaluations = await readProjections({
      pool: options.pool,
      actor,
      orgId,
      projectId: c.req.param("projectId"),
      evaluationId,
    });
    const evaluation = evaluations?.[0];
    if (evaluation === undefined) return c.json({ error: "merge_queue_evaluation_not_found" }, 404);
    return c.json(DetailResponse.parse({ evaluation }));
  });
  return app;
}
