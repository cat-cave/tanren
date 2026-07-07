// apex v79/v80 loop closure — MATERIALIZE the triage-emitted cross-scope work items
// as REAL DAG specs so the "route out as spec" decision actually lands on the DAG.
// Without this seam, `SubtaskLoopOutcome.newSpecs` is a value object that flows up
// through `PlannerRunResult.outcome` and vanishes — no production code calls
// `acceptProposals` on it, so every triaged out-of-scope spec is a black hole.
//
// SHAPE. The workflow (`plannerRun.ts`) holds no DB coupling to discovery/inbox; the
// worker (`runExecutor.ts`) wires the real materializer that calls `acceptProposals`
// under the run's org scope, stamping provenance as `"auto-routed from triage in
// <parentSpecId>"`. Unit tests / non-DB paths omit the seam — the outcome's
// `newSpecs` remains observable on the return value but nothing is persisted (the
// pre-v80 behavior). Cross-loop dedup lives in `plannerRun.ts`, which tracks the
// ids already materialized so a rework/re-plan iteration is idempotent.
//
// Codex round-3 #4 — CROSS-RUN dedupe. The `materializedNewSpecIds` set in
// `plannerRun.ts` is per-run in-memory: a re-drive that fires materialize AGAIN on
// the same triage-routed finding (same parent spec + same finding ids) would
// insert a duplicate spec. The persisted provenance columns (PR #755) make the
// invariant queryable; this module runs the read + skips `acceptProposals` when a
// matching spec already exists. Canonicalization (sort of `sourceFindingIds`) is
// enforced on the WRITE side in `projectSpec.ts` so the DB comparison is stable;
// the partial unique index `specs_triage_provenance_unique` (migration 0027) is
// the belt-and-suspenders that catches any read-then-insert race.
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { acceptProposals, type DiscoveryInsight, type ProposedSpec } from "../forge/discovery/index.js";
import type { NewSpecRequest } from "./subtaskLoop.js";

export interface TriageNewSpecsMaterializerInput {
  runId: string;
  parentSpecId: string;
  projectId: string;
  orgId: string;
  newSpecs: ReadonlyArray<NewSpecRequest>;
}

/** Materialize triaged `kind: spec` items as new DAG specs (fresh, not re-materialized). */
export type TriageNewSpecsMaterializer = (input: TriageNewSpecsMaterializerInput) => Promise<void>;

/**
 * Build the production materializer: for each triage-emitted new-spec, commit a DAG
 * spec via `acceptProposals` under the run's org scope, stamping provenance keyed to
 * the parent spec. The `runStateWriter` is plane-split-aware (control-plane when
 * remote-writes is on, else direct). The insight body embeds the triaged item's title
 * + body so the created spec's discovery card renders the routing trail.
 *
 * Claude RA2 — the four durable provenance columns (`parent_spec_id`,
 * `source_finding_ids`, `origin_triage_task_id`, `origin_run_id`) are threaded onto
 * the created spec through `acceptProposals` → `createSpec`. Before this seam, the
 * routing trail lived ONLY in the discovery jsonb metadata blob (via `source:
 * "triage:<parentSpecId>"`), which made queryable dedup ("has this triage already
 * routed this finding?") impossible.
 */
export function buildTriageNewSpecsMaterializer(deps: {
  pool: pg.Pool;
  runStateWriter?: RunStateWriter;
  /** Resolve a system actor carrying the run's org so the spec write is RLS-scoped. */
  resolveActor: (orgId: string) => ActorContext;
}): TriageNewSpecsMaterializer {
  return async ({ runId, parentSpecId, projectId, orgId, newSpecs }) => {
    for (const req of newSpecs) {
      // Codex round-3 #4 — CROSS-RUN dedupe. Sort the `findingIds` (canonical
      // form; the write side sorts too) and query for an already-materialized
      // spec with the same `(project_id, parent_spec_id, source_finding_ids)`
      // trail. If found, skip `acceptProposals` — the trail is already on the
      // DAG. Race against a concurrent materialization is caught by the partial
      // unique index `specs_triage_provenance_unique` (migration 0027); the
      // insert would fail LOUD (not silently duplicate).
      const canonicalFindingIds = [...req.findingIds].sort();
      const existing = await findRoutedSpecByProvenance(deps.pool, {
        orgId,
        projectId,
        parentSpecId,
        canonicalFindingIds,
      });
      if (existing !== undefined) continue;

      const insight: DiscoveryInsight = {
        variant: "feature",
        source: `triage:${parentSpecId}`,
        sourceLabel: "triage routing",
        who: "Tanren triage",
        when: new Date().toISOString(),
        glyph: "◍",
        body: `Auto-routed from triage of ${parentSpecId}: ${req.title}\n\n${req.body}`.slice(0, 8000),
      };
      const proposal: ProposedSpec = {
        proposalId: `triage_${req.id}`,
        title: req.title,
        description: req.body,
        acceptanceCriteria: [`Address the out-of-scope work triaged from ${parentSpecId}: ${req.title}`],
        dependsOn: [],
        priority: "tbd",
        estLabel: "",
      };
      await acceptProposals(
        {
          pool: deps.pool,
          ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
        },
        {
          projectId,
          insight,
          proposals: [proposal],
          placementKind: "slot_after",
          placementLabel: `auto-routed from triage in ${parentSpecId}`,
          actor: deps.resolveActor(orgId),
          // Claude RA2 — first-class routing PROVENANCE persisted onto the created
          // spec's columns so an operator (or a dedupe pass) can trace the routed
          // spec back to its origin without parsing the discovery jsonb.
          // `originTriageTaskId` is threaded through the NewSpecRequest from the
          // triage stage that emitted the item (`runSubtaskIteration.ts`); an
          // upstream that skipped triage yields the empty string here (a
          // diagnostic breadcrumb, not a silent success) so the parent/finding
          // trail still stamps and a re-drive dedupe query keying off
          // `parent_spec_id` + `source_finding_ids` still identifies the routed
          // spec.
          triageProvenance: {
            parentSpecId,
            // Canonical (sorted) — the write side re-canonicalizes for defence in depth.
            sourceFindingIds: canonicalFindingIds,
            originTriageTaskId: req.originTriageTaskId ?? "",
            originRunId: runId,
          },
        },
      );
    }
  };
}

/**
 * Codex round-3 #4 — the re-drive dedupe READ. Look up an already-materialized
 * routed spec by its persisted provenance trail: `(project_id, parent_spec_id,
 * source_finding_ids)` under the run's org scope (RLS-scoped read). Callers pass
 * `canonicalFindingIds` already-sorted; the DB column is sorted at write time
 * (`projectSpec.ts::canonicalizeTriageProvenance`) so `text[]` equality holds.
 * Returns the existing `spec_id` on a match, `undefined` otherwise.
 */
export async function findRoutedSpecByProvenance(
  pool: pg.Pool,
  input: {
    orgId: string;
    projectId: string;
    parentSpecId: string;
    canonicalFindingIds: ReadonlyArray<string>;
  },
): Promise<string | undefined> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const result = await client.query<{ spec_id: string }>(
      `SELECT spec_id FROM specs
        WHERE project_id = $1
          AND parent_spec_id = $2
          AND source_finding_ids = $3::text[]
        LIMIT 1`,
      [input.projectId, input.parentSpecId, [...input.canonicalFindingIds]],
    );
    return result.rows[0]?.spec_id;
  });
}

/** The default system actor for the auto-routed materialize path (platform:admin, org-scoped). */
export function triageMaterializerSystemActor(orgId: string): ActorContext {
  return {
    userId: "triage-routing",
    orgId,
    projectId: null,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
}

/**
 * apex v79/v80 loop closure — materialize the fresh (not-yet-tracked) newSpecs from an
 * outcome. Called by `plannerRun.ts` inside the outer for loop; mutates the tracker set
 * so a rework/re-plan iteration is idempotent. No-op when the seam is not wired or every
 * item is already tracked.
 */
export async function materializeFreshTriageNewSpecs(
  materializer: TriageNewSpecsMaterializer | undefined,
  outcome: { newSpecs: ReadonlyArray<NewSpecRequest> },
  tracked: Set<string>,
  ctx: { runId: string; parentSpecId: string; projectId: string; orgId: string },
): Promise<void> {
  if (materializer === undefined || outcome.newSpecs.length === 0) return;
  const fresh = outcome.newSpecs.filter((s) => !tracked.has(s.id));
  if (fresh.length === 0) return;
  await materializer({ ...ctx, newSpecs: fresh });
  for (const s of fresh) tracked.add(s.id);
}
