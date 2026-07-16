import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BehaviorRevisionId } from "../contracts/behaviorRevision.js";
import { parseDigest } from "../contracts/cas.js";
import type { BehaviorCoverageEdgeId } from "../contracts/runtimeVerification.js";
import type { QueryClient } from "../data/orgScopedDb.js";
import type {
  BehaviorCoverageEdge,
  BehaviorCoverageSnapshot,
  BoundBehaviorCoverageSnapshot,
  CoverageEdgeKind,
} from "../runtimeVerification/affectedSelection.js";
import { canonicalCoverageSnapshot, COVERAGE_EDGE_KINDS } from "../runtimeVerification/affectedSelection.js";

export interface BehaviorCoverageScope {
  readonly orgId: string;
  readonly projectId: string;
}

export interface RecordBehaviorCoverageEdgeInput {
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly kind: CoverageEdgeKind;
  readonly targetRef: string;
}

export interface BehaviorCoverageEdgesRepository {
  record(
    client: QueryClient,
    scope: BehaviorCoverageScope,
    input: RecordBehaviorCoverageEdgeInput,
  ): Promise<BehaviorCoverageEdge>;
  readSnapshot(client: QueryClient, scope: BehaviorCoverageScope): Promise<BehaviorCoverageSnapshot>;
  readBoundSnapshot(
    client: QueryClient,
    scope: BehaviorCoverageScope,
    integrationNodeId: string,
  ): Promise<BoundBehaviorCoverageSnapshot>;
  lockAndReadBoundSnapshot(
    client: QueryClient,
    scope: BehaviorCoverageScope,
    integrationNodeId: string,
  ): Promise<BoundBehaviorCoverageSnapshot>;
}

export class BehaviorCoverageSubjectNotFoundError extends Error {
  public override readonly name = "BehaviorCoverageSubjectNotFoundError";
}

export class CoverageIntegrationNodeUnavailableError extends Error {
  public override readonly name = "CoverageIntegrationNodeUnavailableError";
}

const CoverageEdgeRowSchema = z
  .object({
    id: z.string().min(1),
    edge_kind: z.enum(COVERAGE_EDGE_KINDS),
    target_ref: z.string().min(1),
  })
  .strict();

const CoverageGraphRowSchema = z
  .object({
    behavior_revision_id: z.string().min(1),
    behavior_content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    behavior_title: z.string(),
    edge_id: z.string().min(1).nullable(),
    edge_kind: z.enum(COVERAGE_EDGE_KINDS).nullable(),
    target_ref: z.string().min(1).nullable(),
  })
  .strict();

const IntegrationNodeRowSchema = z
  .object({
    node_id: z.string().min(1),
    base_sha: z.string().regex(/^[0-9a-f]{40}$/u),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
    tree_hash: z.string().min(1),
    member_key: z.string().regex(/^[0-9a-f]{64}$/u),
    affected_fingerprint: z.string(),
    status: z.enum(["ready", "landed"]),
  })
  .strict();

function toBehaviorRevisionId(value: string): BehaviorRevisionId {
  return value as BehaviorRevisionId;
}

function toCoverageEdge(row: z.infer<typeof CoverageEdgeRowSchema>): BehaviorCoverageEdge {
  return {
    id: row.id as BehaviorCoverageEdgeId,
    kind: row.edge_kind,
    targetRef: row.target_ref,
  };
}

async function readSnapshot(client: QueryClient, scope: BehaviorCoverageScope): Promise<BehaviorCoverageSnapshot> {
  const result = await client.query(
    `SELECT br.id AS behavior_revision_id,
            br.content_digest AS behavior_content_digest,
            br.title AS behavior_title,
            edge.id AS edge_id,
            edge.edge_kind,
            edge.target_ref
       FROM behavior_revisions br
       LEFT JOIN behavior_coverage_edges edge
         ON edge.org_id = $1
        AND edge.project_id = $2
        AND edge.behavior_revision_id = br.id
      WHERE br.org_id = $1
        AND br.status = 'active'
        AND (br.project_id = $2 OR br.project_id IS NULL)
      ORDER BY br.id, edge.edge_kind, edge.target_ref, edge.id`,
    [scope.orgId, scope.projectId],
  );

  const behaviors = new Map<
    BehaviorRevisionId,
    {
      behaviorRevisionId: BehaviorRevisionId;
      contentDigest: ReturnType<typeof parseDigest>;
      title: string;
      edges: BehaviorCoverageEdge[];
    }
  >();
  for (const raw of result.rows) {
    const row = CoverageGraphRowSchema.parse(raw);
    const behaviorRevisionId = toBehaviorRevisionId(row.behavior_revision_id);
    const behavior = behaviors.get(behaviorRevisionId) ?? {
      behaviorRevisionId,
      contentDigest: parseDigest(row.behavior_content_digest),
      title: row.behavior_title,
      edges: [],
    };
    if (behavior.contentDigest !== row.behavior_content_digest || behavior.title !== row.behavior_title) {
      throw new Error(`inconsistent behavior revision projection for ${behaviorRevisionId}`);
    }
    const edgeFields = [row.edge_id, row.edge_kind, row.target_ref];
    const allNull = edgeFields.every((value) => value === null);
    const allPresent = edgeFields.every((value) => value !== null);
    if (!allNull && !allPresent) throw new Error(`partial behavior coverage edge for ${behaviorRevisionId}`);
    if (allPresent) {
      behavior.edges.push({
        id: row.edge_id as BehaviorCoverageEdgeId,
        kind: row.edge_kind as CoverageEdgeKind,
        targetRef: row.target_ref as string,
      });
    }
    behaviors.set(behaviorRevisionId, behavior);
  }
  return canonicalCoverageSnapshot({
    orgId: scope.orgId,
    projectId: scope.projectId,
    behaviors: [...behaviors.values()],
  });
}

async function readBinding(client: QueryClient, scope: BehaviorCoverageScope, integrationNodeId: string) {
  const result = await client.query(
    `SELECT node_id, base_sha, head_sha, tree_hash, member_key, affected_fingerprint, status
       FROM integration_nodes
      WHERE org_id = $1
        AND project_id = $2
        AND node_id = $3
        AND status IN ('ready', 'landed')
        AND head_sha IS NOT NULL
        AND tree_hash IS NOT NULL`,
    [scope.orgId, scope.projectId, integrationNodeId],
  );
  const raw = result.rows[0];
  if (raw === undefined) {
    throw new CoverageIntegrationNodeUnavailableError(
      `ready integration node ${integrationNodeId} is unavailable in ${scope.orgId}/${scope.projectId}`,
    );
  }
  const row = IntegrationNodeRowSchema.parse(raw);
  return {
    binding: {
      integrationNodeId: row.node_id,
      baseSha: row.base_sha,
      preparedHeadSha: row.head_sha,
      treeHash: row.tree_hash,
      memberKey: row.member_key,
    },
    authorityFingerprint: row.affected_fingerprint,
  };
}

async function readBoundSnapshot(
  client: QueryClient,
  scope: BehaviorCoverageScope,
  integrationNodeId: string,
): Promise<BoundBehaviorCoverageSnapshot> {
  const node = await readBinding(client, scope, integrationNodeId);
  const snapshot = await readSnapshot(client, scope);
  return { ...node, snapshot };
}

export const BehaviorCoverageEdgesStore: BehaviorCoverageEdgesRepository = {
  async record(client, scope, input): Promise<BehaviorCoverageEdge> {
    const id = `coverage_edge_${randomUUID()}`;
    const result = await client.query(
      `WITH subject AS (
         SELECT id
           FROM behavior_revisions
          WHERE org_id = $1
            AND id = $4
            AND status = 'active'
            AND (project_id = $2 OR project_id IS NULL)
       ), dependency_target AS (
         SELECT id
           FROM behavior_revisions
          WHERE org_id = $1
            AND id = $6
            AND status = 'active'
            AND (project_id = $2 OR project_id IS NULL)
       )
       INSERT INTO behavior_coverage_edges
         (org_id, id, project_id, behavior_revision_id, edge_kind, target_ref)
       SELECT $1, $3, $2, subject.id, $5, $6
         FROM subject
        WHERE $5 <> 'dependency' OR EXISTS (SELECT 1 FROM dependency_target)
       RETURNING id, edge_kind, target_ref`,
      [scope.orgId, scope.projectId, id, input.behaviorRevisionId, input.kind, input.targetRef],
    );
    const raw = result.rows[0];
    if (raw === undefined) {
      throw new BehaviorCoverageSubjectNotFoundError(
        `active behavior coverage subject or dependency target not found in ${scope.orgId}/${scope.projectId}`,
      );
    }
    return toCoverageEdge(CoverageEdgeRowSchema.parse(raw));
  },

  readSnapshot,

  readBoundSnapshot,

  async lockAndReadBoundSnapshot(client, scope, integrationNodeId): Promise<BoundBehaviorCoverageSnapshot> {
    // SHARE conflicts with the ROW EXCLUSIVE lock used by INSERT/UPDATE/DELETE.
    // Holding all three until the event transaction commits makes the final
    // compare + append one stable publication boundary.
    await client.query("LOCK TABLE integration_nodes, behavior_revisions, behavior_coverage_edges IN SHARE MODE");
    return readBoundSnapshot(client, scope, integrationNodeId);
  },
};
