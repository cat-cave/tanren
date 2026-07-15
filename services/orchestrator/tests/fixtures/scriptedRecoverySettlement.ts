import type {
  ConflictRecoveryDisposition,
  ConflictRecoverySettlement,
  ReplanRouteResult,
} from "../../src/engine/contracts/conflictResolution.js";

/** Default durable planner owner for base-shift persistence fakes. */
export function ownedPlannerRecovery(specId: string): ReplanRouteResult {
  return {
    kind: "owned",
    receipt: {
      kind: "planner_replan",
      specId,
      run: { kind: "enqueued", replanRunId: `run_replan_${specId}`, plannerTaskId: `task_replan_${specId}` },
    },
  };
}

/** Scripted settlement used only by unit fakes; parking_required proves a park. */
export function settleRecoveryForTest(recovery: ConflictRecoveryDisposition): ConflictRecoverySettlement {
  if (recovery.kind === "owned" || recovery.kind === "terminal_noop") return recovery;
  if (recovery.kind === "parking_required") return { kind: "parked", newlyParked: true };
  return {
    kind: "parking_failed",
    message: recovery.message,
    queueDisposition: "unknown",
    retryAfterMs: 3_000,
  };
}
