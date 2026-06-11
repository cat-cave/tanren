// The org-scoped ancestor-stack resolver seam + its pg wiring (walker-jj-local-integration-
// design.md §2.1, §2.3), split out of `walkerPg.ts` to keep that file under the 500-line cap.
// The DagWalker + the change-percolation kick-off both resolve a dependent's ordered
// unmerged-ancestor stack through this seam — the real PR-head branches the dependent
// jj-assembles its base from at bootstrap; NO synthesized host integration ref is built.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type ResolvedAncestorBranch, resolveDependentAncestorStack } from "./ancestorStack.js";

/**
 * Resolve a dependent's ordered unmerged-ancestor stack — the real PR-head branches the
 * dependent will jj-assemble its base from at bootstrap (DAG order). The walker persists
 * this on the speculative run as `ancestor_stack`; NO synthesized host integration ref is
 * built. A seam so the walker/kick-off are conformance-tested without a DB.
 */
export interface DagAncestorStackResolver {
  resolveStack(input: {
    projectId: string;
    /** The unmerged ancestor spec ids, in DAG order (ancestors before dependents). */
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<ResolvedAncestorBranch>>;
}

/**
 * The pg-backed {@link DagAncestorStackResolver}: resolve the project's org, then resolve
 * the ordered ancestor branches under that ORG SCOPE (RLS) via the pure
 * `resolveDependentAncestorStack` helper — an off-scope/phantom ancestor is a hard error
 * (never silently dropped). Returns `{specId, runId, branch}` triples; the per-ancestor
 * `headSha` is captured later at the dependent's bootstrap assembly (the PR-8c write-back).
 */
export class PgDagAncestorStackResolver implements DagAncestorStackResolver {
  constructor(private readonly pool: pg.Pool) {}

  async resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<ResolvedAncestorBranch>> {
    if (input.unmergedAncestorSpecIds.length === 0) return [];
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [input.projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      throw new Error(`cannot resolve ancestor stack: project ${input.projectId} has no resolvable org`);
    }
    return runWithOrgScope(this.pool, orgId, (client) =>
      resolveDependentAncestorStack(client, input.unmergedAncestorSpecIds),
    );
  }
}
