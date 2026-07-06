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
 */
export function buildTriageNewSpecsMaterializer(deps: {
  pool: pg.Pool;
  runStateWriter?: RunStateWriter;
  /** Resolve a system actor carrying the run's org so the spec write is RLS-scoped. */
  resolveActor: (orgId: string) => ActorContext;
}): TriageNewSpecsMaterializer {
  return async ({ parentSpecId, projectId, orgId, newSpecs }) => {
    for (const req of newSpecs) {
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
        },
      );
    }
  };
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
