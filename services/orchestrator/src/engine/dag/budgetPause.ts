// The DagWalker's terminal budget-pause effect, split from walker.ts to preserve
// the architecture line cap. The caller supplies the canonical ready count; this
// module emits the existing named proof and returns the no-enqueue walk result.

import type { ProjectBudgetState, WalkResult } from "../contracts/dagWalker.js";
import type { DagEventEmitter } from "./walkerPg.js";

export async function pauseDagOnBudget(
  events: Pick<DagEventEmitter, "emitBudgetPaused">,
  projectId: string,
  budget: ProjectBudgetState,
  readyHeldBack: number,
): Promise<WalkResult> {
  await events.emitBudgetPaused({
    projectId,
    ceilingUsd: budget.ceilingUsd ?? 0,
    spentUsd: budget.spentUsd,
    period: budget.period,
    readyHeldBack,
    ...(budget.failClosed !== undefined && { reason: budget.failClosed }),
  });
  return { projectId, status: "budget_paused", enqueuedSpecIds: [], enqueuedRunIds: [] };
}
