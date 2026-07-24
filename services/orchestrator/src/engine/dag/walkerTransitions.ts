// Pure DagWalker outcome transitions. Keeping these decisions separate from the
// I/O-heavy walk loop makes the event-producing orchestration easier to audit:
// callers retain responsibility for emitting effects in their existing order.

import type { DagTickStatus, ProjectBudgetState, WalkResult } from "../contracts/dagWalker.js";
import type { SpeculationThreshold } from "../config/index.js";
import type { AncestorStack, ResolvedAncestorBranch } from "./ancestorStack.js";

export type { AncestorStack };
export { decideAncestorWait, pruneAncestorWaitBackoff } from "./ancestorWaitGate.js";

/** The terminal result for a project that is not eligible to enter planning. */
export function inactiveProjectWalkResult(
  projectId: string,
  lifecycle: "deriving" | "archived" | "missing",
): WalkResult {
  return {
    projectId,
    status: lifecycle === "missing" ? "inactive" : lifecycle,
    enqueuedSpecIds: [],
    enqueuedRunIds: [],
  };
}

/** The terminal result after every planned enqueue has been attempted. */
export function completedWalkResult(
  projectId: string,
  plannedStatus: DagTickStatus,
  enqueuedSpecIds: string[],
  enqueuedRunIds: string[],
): WalkResult {
  return {
    projectId,
    status: enqueuedSpecIds.length > 0 ? "enqueued" : plannedStatus,
    enqueuedSpecIds,
    enqueuedRunIds,
  };
}

/** Ordered budget milestones crossed by a usable configured ceiling. */
export function budgetMilestoneBands(budget: ProjectBudgetState): Array<50 | 80> {
  if (budget.failClosed !== undefined || budget.ceilingUsd === undefined || budget.ceilingUsd <= 0) return [];

  const fraction = budget.spentUsd / budget.ceilingUsd;
  const bands: Array<50 | 80> = [];
  if (fraction >= 0.5) bands.push(50);
  if (fraction >= 0.8) bands.push(80);
  return bands;
}

/** Ordered event inputs for each budget milestone that must be recorded. */
export function budgetMilestoneEvents(projectId: string, budget: ProjectBudgetState) {
  const ceilingUsd = budget.ceilingUsd;
  if (ceilingUsd === undefined) return [];
  return budgetMilestoneBands(budget).map((band) => ({
    projectId,
    band,
    ceilingUsd,
    spentUsd: budget.spentUsd,
    period: budget.period,
  }));
}

/** Preserve the established default-branch enqueue event payload exactly. */
export function standardEnqueuedEvent(
  projectId: string,
  specId: string,
  runId: string,
  satisfiedDependsOn: string[],
  inFlightBefore: number,
  concurrencyCeiling: number,
) {
  return { projectId, specId, runId, satisfiedDependsOn, inFlightBefore, concurrencyCeiling };
}

/** Preserve the established speculative enqueue event payload exactly. */
export function speculativeEnqueuedEvent(
  projectId: string,
  specId: string,
  runId: string,
  unmergedAncestors: string[],
  threshold: SpeculationThreshold,
) {
  return { projectId, specId, runId, unmergedAncestors, threshold };
}

/** The runtime's resolved ancestor branches become bootstrap-owned empty-SHA stack entries. */
export function unresolvedAncestorStack(members: ReadonlyArray<ResolvedAncestorBranch>): AncestorStack {
  return members.map((member) => ({ specId: member.specId, runId: member.runId, branch: member.branch, headSha: "" }));
}
