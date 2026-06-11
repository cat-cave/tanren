// The typed ANCESTOR STACK (walker-jj-local-integration-design.md §2.3, §7 PR-1).
//
// A dependent speculative run is stacked on an ORDERED list of not-yet-landed
// ancestors — `[{ specId, runId, branch, headSha }]` (the SAME shape as
// `IntegrationNodeMember`, `contracts/integrationNodes.ts:41`). Order is DAG order
// (ancestors before dependents) and is LOAD-BEARING (it is the assembly order + the
// `memberKey` order). This ONE ordered structure replaces the parallel pair the run
// row carries today — `runs.speculative_base` (a single synthesized integration ref)
// + `runs.integrated_ancestor_shas` (the per-ancestor head-sha map). A run is
// "speculative" iff its stack is non-empty.
//
// `runs.ancestor_stack` is the SOLE base source (WS-B PR-9): the walker/base-shift write
// ONLY this column, and every read path (`runExecutionContext`, `plannerRunWorkspace`,
// `githubDraftPr`, `resolveSpeculativeState`, `percolationPg`) resolves the stack from it
// via `resolveAncestorStack`. The legacy `speculative_base` + `integrated_ancestor_shas`
// columns are no longer written or read (they are dropped in PR-12's migration).

import { z } from "zod";
import type { IntegrationNodeMember } from "../contracts/integrationNodes.js";

/**
 * One ordered ancestor the run is stacked on. Identical to `IntegrationNodeMember`
 * (the integration-node member shape) — the ancestor's (spec, run) whose PR-head
 * `branch` at `headSha` is part of the dependent's dynamic base.
 */
export type AncestorStackMember = IntegrationNodeMember;

/** The ordered ancestor stack — DAG order (ancestors before dependents). */
export type AncestorStack = ReadonlyArray<AncestorStackMember>;

/** Zod schema for one stack member (the persisted `ancestor_stack` element shape). */
export const ancestorStackMemberSchema = z.object({
  specId: z.string(),
  runId: z.string(),
  branch: z.string(),
  headSha: z.string(),
});

/** Zod schema for the ordered ancestor stack as persisted in `runs.ancestor_stack`. */
export const ancestorStackSchema = z.array(ancestorStackMemberSchema);

/** The subset of a run row this resolver reads — the `runs.ancestor_stack` column. */
export interface AncestorStackRunRow {
  /** The `runs.ancestor_stack` column (jsonb) — `unknown` until validated. */
  ancestorStack?: unknown;
}

/**
 * Resolve the ordered {@link AncestorStack} for a run from its `runs.ancestor_stack`
 * column (the SOLE base source). Returns an EMPTY stack for a non-speculative run (no
 * column / not a well-formed non-empty list).
 */
export function resolveAncestorStack(run: AncestorStackRunRow): AncestorStack {
  const fromColumn = ancestorStackSchema.safeParse(run.ancestorStack);
  return fromColumn.success ? fromColumn.data : [];
}

// ---------------------------------------------------------------------------
// WRITE-side resolution: the DAG-ordered ancestor-stack resolver
// (walker-jj-local-integration-design.md §2.1, §2.3, §7 PR-2).
//
// For a dependent spec about to be enqueued speculatively, resolve its ordered
// unmerged-ancestor PR-head stack from the DAG: each unmerged ancestor's latest
// run branch (= the PR head branch `draftPrBranchName` produces) zipped with its
// run id, in the caller's DAG order (ancestors before dependents — the order the
// walker already passes). This is the WRITE side of the AncestorStack, co-located
// here with the read/dual-read side above.
//
// It is org-scoped (RLS-safe): the caller passes an ALREADY org-scoped client (one
// opened under `runWithOrgScope`), so a query off the scoped client sees ONLY the
// project org's rows — an off-scope ancestor resolves to zero rows and surfaces as
// the missing-branch hard error (a phantom ancestor is never silently integrated).
//
// This is the pure DAG-resolve previously inline in `PgSpeculativeIntegrator`
// (`speculativeIntegrator.ts` `loadAncestorBranches` + the ordering loop). The
// per-ancestor `headSha` is NOT resolved here — it is captured at assembly time by
// the caller (today the `VcsProvider.buildIntegrationBranch` build, tomorrow the
// jj-local assembly), so this resolver returns the `{ specId, runId, branch }`
// triples and the caller zips in `headSha`.

/**
 * One resolved unmerged ancestor — its (spec, run) and the PR-head `branch`, in
 * DAG order. The `headSha` (the assembly-time divergence key) is captured by the
 * caller, so it is NOT part of this resolve.
 */
export interface ResolvedAncestorBranch {
  specId: string;
  runId: string;
  branch: string;
}

/** One ancestor's resolved run row (latest run per spec). */
interface AncestorBranchRow {
  spec_id: string;
  run_id: string;
  branch: string;
}

/**
 * The minimal org-scoped query surface the resolver needs — a `runWithOrgScope`
 * client (or any `pg.PoolClient`). Narrowed to the one query the resolver issues so
 * it is trivially mockable in a unit test without the full `pg` type.
 */
export interface AncestorStackQueryClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Resolve the ordered unmerged-ancestor branch stack for a dependent, off an
 * ALREADY org-scoped `client` (RLS-safe). Returns the ancestors in the caller's DAG
 * order (`unmergedAncestorSpecIds` is already DAG-ordered); a spec with no resolvable
 * run branch under the org scope is a HARD ERROR (a phantom ancestor is never
 * silently dropped). The result carries `runId` + `branch`; the caller zips in the
 * assembly-time `headSha`.
 */
export async function resolveDependentAncestorStack(
  client: AncestorStackQueryClient,
  unmergedAncestorSpecIds: ReadonlyArray<string>,
): Promise<ResolvedAncestorBranch[]> {
  const rows = await loadAncestorBranchRows(client, unmergedAncestorSpecIds);
  // Order the ancestor branches in the caller's DAG order; resolve each spec's
  // branch, dropping none silently — a missing ancestor branch is a hard error
  // (we never integrate a phantom).
  const branchBySpec = new Map(rows.map((r) => [r.spec_id, r.branch] as const));
  const runIdBySpec = new Map(rows.map((r) => [r.spec_id, r.run_id] as const));
  return unmergedAncestorSpecIds.map((specId) => {
    const branch = branchBySpec.get(specId);
    if (branch === undefined) {
      throw new Error(`unmerged ancestor ${specId} has no run branch to integrate`);
    }
    return { specId, runId: runIdBySpec.get(specId) ?? "", branch };
  });
}

/**
 * Load one run row per ancestor spec — the latest run's branch is its PR head
 * branch. Off the org-scoped client (RLS), so off-scope specs return zero rows.
 */
async function loadAncestorBranchRows(
  client: AncestorStackQueryClient,
  specIds: ReadonlyArray<string>,
): Promise<AncestorBranchRow[]> {
  if (specIds.length === 0) return [];
  const result = await client.query<AncestorBranchRow>(
    `SELECT DISTINCT ON (r.spec_id) r.spec_id, r.run_id, r.branch
       FROM runs r
      WHERE r.spec_id = ANY($1::text[])
      ORDER BY r.spec_id, r.started_at DESC`,
    [[...specIds]],
  );
  return result.rows;
}
