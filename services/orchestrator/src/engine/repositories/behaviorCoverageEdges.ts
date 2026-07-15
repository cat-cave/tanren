import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BehaviorRevisionId } from "../contracts/behaviorRevision.js";
import type { BehaviorCoverageEdgeId } from "../contracts/runtimeVerification.js";
import type { QueryClient } from "../data/orgScopedDb.js";
import type {
  BehaviorCoverageEdge,
  BehaviorCoverageSnapshot,
  CoverageEdgeKind,
} from "../runtimeVerification/affectedSelection.js";
import { COVERAGE_EDGE_KINDS } from "../runtimeVerification/affectedSelection.js";
import type { ActorRef } from "../state/actor.js";

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
    actor: ActorRef,
  ): Promise<BehaviorCoverageEdge>;
  readSnapshot(client: QueryClient, scope: BehaviorCoverageScope, actor: ActorRef): Promise<BehaviorCoverageSnapshot>;
}

export class BehaviorCoverageSubjectNotFoundError extends Error {
  public override readonly name = "BehaviorCoverageSubjectNotFoundError";
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
    behavior_title: z.string(),
    edge_id: z.string().min(1).nullable(),
    edge_kind: z.enum(COVERAGE_EDGE_KINDS).nullable(),
    target_ref: z.string().min(1).nullable(),
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

export const BehaviorCoverageEdgesStore: BehaviorCoverageEdgesRepository = {
  /**
   * Append one persisted edge for an active behavior revision in this exact
   * org/project scope. Dependency targets must also be active and visible in
   * the same project (or org-scoped with project_id NULL); dangling edges never
   * enter the graph through this authority.
   */
  async record(
    client: QueryClient,
    scope: BehaviorCoverageScope,
    input: RecordBehaviorCoverageEdgeInput,
    _actor: ActorRef,
  ): Promise<BehaviorCoverageEdge> {
    const id = `coverage_edge_${randomUUID()}`;
    const result = await client.query(
      `WITH subject AS (
       SELECT id
           FROM behavior_revisions br
          WHERE br.org_id = $1
            AND br.id = $4
            AND br.status = 'active'
            AND (br.project_id = $2 OR br.project_id IS NULL)
       ), dependency_target AS (
         SELECT id
           FROM behavior_revisions dependency
          WHERE dependency.org_id = $1
            AND dependency.id = $6
            AND dependency.status = 'active'
            AND (dependency.project_id = $2 OR dependency.project_id IS NULL)
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

  /**
   * Read the active behavior revisions and their complete project edge set in
   * one SQL statement, giving the selector one MVCC snapshot. Both org and
   * project are explicit predicates in addition to FORCE RLS.
   */
  async readSnapshot(
    client: QueryClient,
    scope: BehaviorCoverageScope,
    _actor: ActorRef,
  ): Promise<BehaviorCoverageSnapshot> {
    const result = await client.query(
      `SELECT br.id AS behavior_revision_id,
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
      { behaviorRevisionId: BehaviorRevisionId; title: string; edges: BehaviorCoverageEdge[] }
    >();
    for (const raw of result.rows) {
      const row = CoverageGraphRowSchema.parse(raw);
      const behaviorRevisionId = toBehaviorRevisionId(row.behavior_revision_id);
      const behavior = behaviors.get(behaviorRevisionId) ?? {
        behaviorRevisionId,
        title: row.behavior_title,
        edges: [],
      };
      const edgeFields = [row.edge_id, row.edge_kind, row.target_ref];
      const allNull = edgeFields.every((value) => value === null);
      const allPresent = edgeFields.every((value) => value !== null);
      if (!allNull && !allPresent) {
        throw new Error(`partial behavior_coverage_edges row for ${behaviorRevisionId}`);
      }
      if (allPresent) {
        behavior.edges.push({
          id: row.edge_id as BehaviorCoverageEdgeId,
          kind: row.edge_kind as CoverageEdgeKind,
          targetRef: row.target_ref as string,
        });
      }
      behaviors.set(behaviorRevisionId, behavior);
    }

    return {
      orgId: scope.orgId,
      projectId: scope.projectId,
      behaviors: [...behaviors.values()],
    };
  },
};
