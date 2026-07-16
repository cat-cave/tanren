// Map RecoveryParkWriter / SpecEscalator outcomes onto settle actions.
import type { DequeueReason } from "../contracts/mergeCoordinator.js";
import type { SpecEscalateOutcome } from "./coordinatorEscalate.js";

export type SettleParkAction =
  | { action: "dequeue"; reason: DequeueReason; message: string; alreadyDequeued?: boolean }
  | { action: "retain"; message: string; retryAfterMs: number };

/** Map RecoveryParkWriter / SpecEscalator outcome onto settle action. */
export function settleFromParkOutcome(park: SpecEscalateOutcome, message: string): SettleParkAction {
  if (park.kind === "parked") {
    return {
      action: "dequeue",
      reason: "needs_attention",
      message,
      alreadyDequeued: park.alreadyDequeued,
    };
  }
  if (park.kind === "parking_failed" && park.queueDisposition === "retained") {
    return { action: "retain", message: `${message} (${park.reason})`, retryAfterMs: park.retryAfterMs };
  }
  return {
    action: "retain",
    message: `${message} (parking_failed/${park.reason}; disposition unknown — readback/retry)`,
    retryAfterMs: park.retryAfterMs,
  };
}
