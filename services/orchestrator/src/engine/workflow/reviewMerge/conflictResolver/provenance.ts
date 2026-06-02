// The pg-backed ConflictProvenanceReader (autonomy-engine.md §2b step 1): given
// the merging spec + the conflicted files, identify the OTHER spec the conflict
// is against — and whether a DAG edge connects them.
//
// Attribution strategy. Tanren does not record per-file change provenance, but
// the DAG DOES know which specs are RELATED to the merging spec (its
// dependencies + dependents via `spec_dependencies`). Among the merging spec's
// DAG-adjacent specs whose run has MERGED, the most-recently-merged one is the
// change now on the base branch that the merging spec collided with — this is
// the "which merged run last touched the conflicting files" signal expressed
// through the DAG (the resolver's whole premise: the DAG knows the intent of
// every change). When no DAG-adjacent spec has merged, we fall back to the
// most-recently-merged spec in the PROJECT (still a real provenance signal — the
// last change to land on base — but `dagEdge: false`, so the resolver knows it
// is reasoning without a known dependency relationship). When nothing has merged
// at all, there is no other spec: the resolver proceeds with the merging spec's
// intent alone, never silently dropping the merge.
//
// Scope: the reader runs on the run's already-org-scoped query client (the same
// `orgScopingPool` the run loop threads everywhere). Under RLS a read on the
// wrong scope sees zero rows, so the provenance is always exactly the run's org.
// Like the Repositories seam, the scope lives with the caller, not the reader.

import type pg from "pg";
import type {
  ConflictProvenance,
  ConflictProvenanceReader,
  SpecIntent,
} from "../../../contracts/conflictResolution.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface ConflictingSpecRow {
  spec_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  has_edge: boolean;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class PgConflictProvenanceReader implements ConflictProvenanceReader {
  constructor(private readonly client: QueryClient) {}

  async read(input: {
    projectId: string;
    mergingSpecId: string;
    conflictedFiles: ReadonlyArray<string>;
  }): Promise<ConflictProvenance> {
    // The most-recently-merged spec related to the merging spec in the DAG
    // (either direction of the dependency edge), preferring a DAG-adjacent spec;
    // falling back to the most-recently-merged project spec when no adjacent spec
    // has merged. `has_edge` carries the DAG-edge signal.
    const result = await this.client.query<ConflictingSpecRow>(
      `
      WITH adjacency AS (
        SELECT to_spec_id AS spec_id FROM spec_dependencies WHERE from_spec_id = $2
        UNION
        SELECT from_spec_id AS spec_id FROM spec_dependencies WHERE to_spec_id = $2
      ),
      merged_runs AS (
        SELECT r.spec_id, MAX(r.ended_at) AS merged_at
          FROM runs r
         WHERE r.project_id = $1
           AND r.outcome = 'pr_merged'
           AND r.spec_id <> $2
         GROUP BY r.spec_id
      )
      SELECT s.spec_id, s.title, s.description, s.acceptance_criteria,
             (a.spec_id IS NOT NULL) AS has_edge
        FROM merged_runs mr
        JOIN specs s ON s.spec_id = mr.spec_id AND s.project_id = $1
        LEFT JOIN adjacency a ON a.spec_id = mr.spec_id
       ORDER BY (a.spec_id IS NOT NULL) DESC, mr.merged_at DESC
       LIMIT 1
      `,
      [input.projectId, input.mergingSpecId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { dagEdge: false };
    }
    const intent: SpecIntent = {
      specId: row.spec_id,
      title: row.title,
      description: row.description,
      acceptanceCriteria: asStringArray(row.acceptance_criteria),
    };
    return { conflictingSpecId: row.spec_id, conflictingSpecIntent: intent, dagEdge: row.has_edge };
  }
}
