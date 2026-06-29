// Small helpers split out of subtaskLoop.ts to keep it under the per-file line cap.
// Both helpers are pure compositions — no engine state, no side effects — they just
// hide repeated noise so the run-loop reads as a sequence of intentions.

import type pg from "pg";
import { type FindingSeverity, severityRank } from "../contracts/findings.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { PlannerTerminalContext, LoopAppendEvent } from "./subtaskTasks.js";
import type { RoutedWorkItem } from "./loopPolicy.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * The minimum SubtaskLoopInput shape this helper reads — accepts a structural
 * subset so the helper doesn't have to import `SubtaskLoopInput` (which would
 * create a circular dependency back into subtaskLoop.ts).
 */
export interface PlannerTerminalContextSource {
  pool: LoopQueryClient;
  runStateWriter?: RunStateWriter;
  context: { runId: string; specId: string; projectId: string };
}

/** task #46: builds the planner-task atomic-terminal context bag once per run. */
export function buildPlannerTerminalContext(
  input: PlannerTerminalContextSource,
  plannerTaskId: string,
  appendEvent: LoopAppendEvent,
): PlannerTerminalContext {
  return {
    pool: input.pool,
    ...(input.runStateWriter !== undefined && { writer: input.runStateWriter }),
    taskId: plannerTaskId,
    lineage: { runId: input.context.runId, specId: input.context.specId, projectId: input.context.projectId },
    appendEvent,
  };
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
