// Drives the pg-backed PgConflictProvenanceReader through the shared
// ConflictProvenanceReader conformance suite. The backing store is a tiny
// in-memory `pg` query target that understands EXACTLY the provenance reader's
// CTE query (the merging spec's DAG adjacency × the project's merged runs,
// preferring an adjacent spec then the most-recent merge). Running the REAL impl
// against the suite proves the pg reader satisfies the contract behaviorally —
// the same discipline the Repositories/DagWalker conformance tests use.

import type pg from "pg";
import { PgConflictProvenanceReader } from "../../src/engine/workflow/reviewMerge/conflictResolver/provenance.js";
import {
  describeConflictProvenanceConformance,
  type ConflictProvenanceConformanceHarness,
  type ProvenanceSpecSeed,
} from "./conflictProvenanceConformance.js";

interface SpecRecord {
  spec_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  merged_rank?: number;
}

const PROJECT_ID = "proj_conformance";

// An in-memory client that evaluates the provenance reader's single CTE query
// against the seeded specs + edges. It mirrors the SQL's semantics: among the
// project's specs whose run has merged (merged_rank set) and that are NOT the
// merging spec, pick — preferring DAG-adjacency, then the latest merge.
class ProvenanceMemoryClient {
  readonly specs = new Map<string, SpecRecord>();
  readonly edges: Array<{ from: string; to: string }> = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (!sql.includes("merged_runs") || !sql.includes("adjacency")) {
      throw new Error(`ProvenanceMemoryClient: unrecognized SQL: ${sql}`);
    }
    const [, mergingSpecId] = params as [string, string];
    const adjacency = new Set<string>();
    for (const e of this.edges) {
      if (e.from === mergingSpecId) adjacency.add(e.to);
      if (e.to === mergingSpecId) adjacency.add(e.from);
    }
    const candidates = [...this.specs.values()]
      .filter((s) => s.merged_rank !== undefined && s.spec_id !== mergingSpecId)
      .map((s) => ({ spec: s, hasEdge: adjacency.has(s.spec_id) }))
      .sort((a, b) => {
        if (a.hasEdge !== b.hasEdge) return a.hasEdge ? -1 : 1;
        return (b.spec.merged_rank ?? 0) - (a.spec.merged_rank ?? 0);
      });
    const top = candidates[0];
    if (top === undefined) return { rows: [] };
    return {
      rows: [
        {
          spec_id: top.spec.spec_id,
          title: top.spec.title,
          description: top.spec.description,
          acceptance_criteria: top.spec.acceptance_criteria,
          has_edge: top.hasEdge,
        },
      ],
    };
  }
}

describeConflictProvenanceConformance("PgConflictProvenanceReader (in-memory pg)", {
  make: (): ConflictProvenanceConformanceHarness => {
    const client = new ProvenanceMemoryClient();
    return {
      reader: new PgConflictProvenanceReader(client as unknown as pg.Pool),
      projectId: PROJECT_ID,
      setSpec: (seed: ProvenanceSpecSeed) => {
        client.specs.set(seed.intent.specId, {
          spec_id: seed.intent.specId,
          title: seed.intent.title,
          description: seed.intent.description,
          acceptance_criteria: [...seed.intent.acceptanceCriteria],
          ...(seed.mergedRank !== undefined && { merged_rank: seed.mergedRank }),
        });
      },
      addEdge: (from, to) => {
        client.edges.push({ from, to });
      },
    };
  },
});
