// subtaskBudget — the PER-ITERATION dollar-budget gate for the spec loop (audit §3.7a).
// Extracted from subtaskLoop.ts to keep that orchestration file under the 500-line
// architecture cap. The enqueue-time DagWalker gate only stops NEW work; this gate stops
// an ALREADY in-flight run the instant its project crosses the configured dollar ceiling
// (or the gate must fail closed — unpriced/unparseable spend), so an over-ceiling cohort
// can never keep spending past the ceiling. The halt PARKS the spec (requeueable); the
// `shouldPauseOnBudget` predicate is the SAME one the walker uses, so the two never drift.
import { type ProjectBudgetState, shouldPauseOnBudget } from "../contracts/dagWalker.js";
import { markPlannerFailed, type PlannerTerminalContext } from "./subtaskTasks.js";
import type { AppendEvent, SubtaskLoopInput, SubtaskLoopOutcome } from "./subtaskLoop.js";

// Resolve the run's project budget and return the over-ceiling/fail-closed state when the
// run must pause THIS iteration, else null. No gate wired (unit paths / a run with no
// budget concern) ⇒ null (no enforcement, byte-identical to before).
export async function checkIterationBudget(input: SubtaskLoopInput): Promise<ProjectBudgetState | null> {
  if (input.budgetGate === undefined) {
    return null;
  }
  const budget = await input.budgetGate.resolveBudget(input.context.projectId);
  return shouldPauseOnBudget(budget) ? budget : null;
}

// Emit the loud `dag.budget.paused` event + mark the planner task FAILED via the atomic
// terminal pair for a per-iteration budget pause (audit finding #4). The prior shape was a
// bare `markTaskDone(rejected_by_auditor)` with NO paired `task.failed` envelope — a §1c
// single-finalize violation: the planner row read terminal-`done` while the timeline had no
// matching terminal `task.*` event, so every $50-ceiling apex pause stranded the audit trail.
// Routing through `markPlannerFailed` (the PR #705 wrapper) lands the row + `task.failed`
// (`failureKind: "budget_paused"`) in ONE org-scoped transaction through the writer seam.
export async function emitBudgetPause(
  _input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  planCtx: PlannerTerminalContext,
  budget: ProjectBudgetState,
): Promise<void> {
  await appendEvent(
    "dag.budget.paused",
    {
      ceilingUsd: budget.ceilingUsd ?? 0,
      spentUsd: budget.spentUsd,
      period: budget.period,
      readyHeldBack: 0,
      ...(budget.failClosed !== undefined && { reason: budget.failClosed }),
    },
    planCtx.taskId,
  );
  await markPlannerFailed(planCtx, "budget_paused", budget.failClosed);
}

// Build the terminal `budget_paused` loop outcome for a per-iteration pause.
export function budgetPausedOutcome(budget: ProjectBudgetState, loopCount: number): SubtaskLoopOutcome {
  return {
    kind: "budget_paused",
    loopCount,
    ceilingUsd: budget.ceilingUsd,
    spentUsd: budget.spentUsd,
    reason:
      budget.failClosed ??
      `cumulative spend $${budget.spentUsd} reached the configured ceiling $${budget.ceilingUsd ?? 0}`,
  };
}
