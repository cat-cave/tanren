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
// PR-1 is ADDITIVE: this type + resolver ship now and the `runs.ancestor_stack`
// column is WRITTEN (dual-write alongside the two legacy columns) but UNREAD; the
// read paths (`runExecutionContext`, `plannerRunWorkspace`, `githubDraftPr`,
// `resolveSpeculativeState`) cut over to `resolveAncestorStack` in later WS-A PRs.
// `resolveAncestorStack` DUAL-READS so a future reader is correct across the
// transition: it reads the new column when present, else reconstructs the stack from
// the legacy columns (best-effort — the legacy columns carry only the per-ancestor
// SHA, so a reconstructed member's `runId`/`branch` are empty until a dual-write
// populated the full shape).

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

/**
 * The subset of a run row this resolver reads. The new `ancestorStack` column is the
 * source of truth when present; the two legacy columns are the dual-read fallback.
 */
export interface AncestorStackRunRow {
  /** The new `runs.ancestor_stack` column (jsonb) — `unknown` until validated. */
  ancestorStack?: unknown;
  /** Legacy `runs.speculative_base` — the single synthesized integration ref, or NULL. */
  speculativeBase?: string | null;
  /** Legacy `runs.integrated_ancestor_shas` — the per-ancestor head-sha map, or NULL. */
  integratedAncestorShas?: unknown;
}

/**
 * PURE: build an ancestor stack from the legacy per-ancestor SHA map
 * (`integrated_ancestor_shas`: `{ "<ancestorSpecId>": "<sha>" }`). The legacy column
 * carries ONLY the spec id + head sha, so the reconstructed member's `runId`/`branch`
 * are empty — the dual-write populates the full shape going forward; this is the
 * best-effort reconstruction a reader gets for a run written before the dual-write.
 * Order is the map's insertion order (the walker built the map in DAG order).
 */
export function ancestorStackFromShaMap(shaMap: Record<string, string>): AncestorStack {
  return Object.entries(shaMap).map(([specId, headSha]) => ({
    specId,
    runId: "",
    branch: "",
    headSha,
  }));
}

/**
 * Resolve the ordered {@link AncestorStack} for a run (DUAL-READ). Reads the new
 * `ancestor_stack` column when it is a present, well-formed list (the source of
 * truth); else reconstructs the stack from the legacy `speculative_base` +
 * `integrated_ancestor_shas` columns. Returns an EMPTY stack for a non-speculative
 * run (no new column, no legacy SHA map).
 */
export function resolveAncestorStack(run: AncestorStackRunRow): AncestorStack {
  const fromColumn = ancestorStackSchema.safeParse(run.ancestorStack);
  if (fromColumn.success && fromColumn.data.length > 0) {
    return fromColumn.data;
  }
  const shaMap = run.integratedAncestorShas;
  if (shaMap !== null && shaMap !== undefined && typeof shaMap === "object") {
    const parsed = z.record(z.string(), z.string()).safeParse(shaMap);
    if (parsed.success && Object.keys(parsed.data).length > 0) {
      return ancestorStackFromShaMap(parsed.data);
    }
  }
  return [];
}
