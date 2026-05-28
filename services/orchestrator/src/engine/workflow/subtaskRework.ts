// Rework-routing helpers shared by runSubtaskLoop. A rejection — from the
// checker, the auditor, or the P3-0005 deterministic gate — is routed back to
// the planner via planner.rerequested up to the per-spec rerun budget. Keeping
// these here keeps subtaskLoop.ts focused on the loop topology under the
// 500-line architecture cap.
import type { PlanSubtask } from "../answerers/schemas/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { GateOutcome } from "./gate/index.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";

interface AppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

// Records a rejection as planner.rerequested feedback and reports whether the
// rerun budget is now exhausted (true → the caller should finalize the run as
// retry_budget_exhausted; false → re-plan). Pushes the rejection onto history
// so the next planner call carries the full prior-rejection context.
export async function handleRejection(args: {
  appendEvent: AppendEvent;
  plannerTaskId: string;
  runId: string;
  max: number;
  rejection: PlannerRejectionFeedback;
  plannerRerunCount: number;
  history: PlannerRejectionFeedback[];
}): Promise<boolean> {
  const nextCount = args.plannerRerunCount + 1;
  if (nextCount > args.max) {
    return true;
  }
  await args.appendEvent(
    "planner.rerequested",
    {
      runId: args.runId,
      plannerTaskId: args.plannerTaskId,
      producer: args.rejection.producer,
      rejectionReason: args.rejection.rejectionReason,
      behaviorIdsFailed: [...args.rejection.behaviorIdsFailed],
      plannerRerunCount: nextCount,
      maxPlannerRerunsPerSpec: args.max
    },
    args.plannerTaskId
  );
  args.history.push(args.rejection);
  return false;
}

// Turns a failed gate outcome into the planner-feedback record routed through
// the same rework path the checker/auditor use. The reason names the tier, the
// lifecycle point, the failing step, and its exit code so the planner re-plans
// against a concrete, deterministic failure. The gate carries no per-behavior
// verdict (it is exit-code only), so behaviorIdsFailed is empty.
export function gateRejection(
  outcome: Extract<GateOutcome, { passed: false }>,
  subtasks: ReadonlyArray<PlanSubtask>
): PlannerRejectionFeedback {
  const { failure } = outcome;
  const exit = failure.exitCode === null ? "no exit code (timed out or substrate failure)" : `exit ${failure.exitCode}`;
  return {
    producer: "gate",
    rejectionReason: `gate tier "${failure.tier}" (${failure.when}) failed at step "${failure.failedStep}" with ${exit}`,
    behaviorIdsFailed: [],
    previousSubtasks: subtasks
  };
}
