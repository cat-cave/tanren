// The typed ANCESTOR STACK (walker-jj-local-integration-design.md §2.3, §7 PR-1).
//
// A dependent speculative run is stacked on an ORDERED list of not-yet-landed
// ancestors — `[{ specId, runId, branch, headSha }]` (the SAME shape as
// `IntegrationNodeMember`, `contracts/integrationNodes.ts:41`). Order is DAG order
// (ancestors before dependents) and is LOAD-BEARING (it is the assembly order + the
// `memberKey` order). This ONE ordered structure replaced the parallel pair the run
// row once carried — a single synthesized integration ref + a per-ancestor head-sha
// map. A run is "speculative" iff its stack is non-empty.
//
// `runs.ancestor_stack` is the SOLE base source (WS-B PR-12): the walker/base-shift write
// ONLY this column, and every read path (`runExecutionContext`, `plannerRunWorkspace`,
// `githubDraftPr`, `resolveSpeculativeState`, `percolationPg`) resolves the stack from it
// via `resolveAncestorStack`. The legacy `speculative_base` + `integrated_ancestor_shas`
// columns were dropped (WS-B PR-12's migration) — `ancestor_stack` is the only truth.
//
// The resolver DISTINGUISHES ABSENT FROM MALFORMED (Codex critic #9): an absent column
// (`null` / `undefined`) resolves to `[]` (a non-speculative run); a PRESENT value that
// fails `ancestorStackSchema` throws `MalformedAncestorStackError` — data corruption
// must NEVER silently degrade to `[]` (that would flip a speculative run non-speculative
// and merge it against the wrong base).

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
 * A persisted `runs.ancestor_stack` value was PRESENT but failed the
 * {@link ancestorStackSchema} parse. Distinct from the ABSENT case (a null/undefined
 * column ⇒ a non-speculative run ⇒ an empty stack): a malformed PRESENT value is data
 * corruption we refuse to silently degrade — silently returning `[]` here would flip
 * a corrupted speculative run to non-speculative and merge it against the wrong base.
 * Fail-closed: the resolver throws this class so callers propagate it up as a real
 * fault (Codex critic #9). Retriable is CALLER's concern — the underlying jsonb
 * doesn't self-heal, so treat as a hard fault unless the caller has evidence otherwise.
 */
export class MalformedAncestorStackError extends Error {
  constructor(
    /** The zod issues from the failed parse, for internal triage. */
    readonly issues: z.ZodIssue[],
    /** The rejected raw value (for diagnostics — a corrupt jsonb payload). */
    readonly rawValue: unknown,
  ) {
    super(
      `runs.ancestor_stack failed schema parse: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
    this.name = "MalformedAncestorStackError";
  }
}

/**
 * Resolve the ordered {@link AncestorStack} for a run from its `runs.ancestor_stack`
 * column (the SOLE base source).
 *
 * Distinguishes ABSENT from MALFORMED (Codex critic #9):
 *  - ABSENT (`null` / `undefined` / no column) ⇒ returns `[]` (a non-speculative run).
 *  - PRESENT + parses ⇒ returns the parsed stack (an empty array is legal — a run whose
 *    stack has fully drained via the retarget walk).
 *  - PRESENT + fails {@link ancestorStackSchema} ⇒ throws
 *    {@link MalformedAncestorStackError}. A corrupt payload MUST NOT silently degrade
 *    to `[]` — that flips a speculative run to non-speculative and merges it against
 *    the wrong base.
 */
export function resolveAncestorStack(run: AncestorStackRunRow): AncestorStack {
  // ABSENT column ⇒ a non-speculative run.
  if (run.ancestorStack === null || run.ancestorStack === undefined) return [];
  // PRESENT column ⇒ MUST parse; a malformed payload is a hard fault, never a silent
  // downgrade to an empty (non-speculative) stack.
  const fromColumn = ancestorStackSchema.safeParse(run.ancestorStack);
  if (!fromColumn.success) {
    throw new MalformedAncestorStackError(fromColumn.error.issues, run.ancestorStack);
  }
  return fromColumn.data;
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
// the caller (the jj-local integration assembly), so this resolver returns the
// `{ specId, runId, branch }` triples and the caller zips in `headSha`.

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
