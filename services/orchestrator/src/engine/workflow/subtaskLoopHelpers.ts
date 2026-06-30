// Small helpers split out of subtaskLoop.ts to keep it under the per-file line cap.
// Both helpers are pure compositions — no engine state, no side effects — they just
// hide repeated noise so the run-loop reads as a sequence of intentions.

import { type FindingSeverity, severityRank } from "../contracts/findings.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { PlannerTerminalContext } from "./subtaskTasks.js";
import type { RoutedWorkItem } from "./loopPolicy.js";

/**
 * The minimum SubtaskLoopInput shape this helper reads — accepts a structural
 * subset so the helper doesn't have to import `SubtaskLoopInput` (which would
 * create a circular dependency back into subtaskLoop.ts).
 */
export interface PlannerTerminalContextSource {
  /** REQUIRED (audit finding H3 sweep — no fallback arm). */
  runStateWriter: RunStateWriter;
  /** v68 fix: tenant key carried on the context for the atomic terminal lineage. */
  context: { runId: string; specId: string; projectId: string; orgId: string };
}

/** task #46: builds the planner-task atomic-terminal context bag once per run. */
export function buildPlannerTerminalContext(
  input: PlannerTerminalContextSource,
  plannerTaskId: string,
): PlannerTerminalContext {
  const { runId, specId, projectId, orgId } = input.context;
  return { writer: input.runStateWriter, taskId: plannerTaskId, lineage: { runId, specId, projectId, orgId } };
}

/**
 * The worst severity among the work items KEPT in-spec this loopback — the
 * "are the leftovers mild?" input to the velocity-defer policy. Undefined when
 * nothing was kept (the leftover-severity gate is then vacuously satisfied).
 */
export function worstKeptSeverity(kept: ReadonlyArray<RoutedWorkItem>): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const { item } of kept) {
    if (worst === undefined || severityRank(item.severity) < severityRank(worst)) {
      worst = item.severity;
    }
  }
  return worst;
}
