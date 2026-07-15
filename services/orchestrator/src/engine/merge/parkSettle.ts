// Exhaustive park-disposition settlement for merge coordinators.
// terminal_noop → superseded (no SpecEscalator); parked → needs_attention;
// parking_required → escalate exactly once; parking_failed → retain entry.

import type { ConflictRecoveryDisposition, GateReworkRouteResult } from "../contracts/conflictResolution.js";
import type { MergeDriveOutcome, MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { SpecEscalateOutcome, SpecEscalator } from "./coordinatorEscalate.js";
import { verifyRecoveryOwnership, type RecoveryEvidencePort } from "./recoveryOwnership.js";

/** Settlement action after writer-rework / park disposition — dequeue or retain. */
export type SettleParkAction =
  | { action: "dequeue"; reason: "superseded" | "needs_attention"; message: string }
  | { action: "retain"; message: string };

/**
 * Map a typed SpecEscalator park outcome onto settle action.
 * parked → needs_attention; terminal_noop → superseded; parking_failed → retain.
 */
export function settleFromEscalateOutcome(park: SpecEscalateOutcome, message: string): SettleParkAction {
  if (park.kind === "parked") {
    return { action: "dequeue", reason: "needs_attention", message };
  }
  if (park.kind === "terminal_noop") {
    return {
      action: "dequeue",
      reason: "superseded",
      message: `${message} (concurrent terminal ${park.status} — queue entry superseded, not needs_attention)`,
    };
  }
  const observed = park.observedStatus === undefined ? "missing row" : `status=${park.observedStatus}`;
  return {
    action: "retain",
    message: `${message} (parking_failed: ${observed} — merge entry retained for recovery)`,
  };
}

/** Exhaustive needs_attention parking settlement (drive outcome path). */
export async function settleNeedsAttentionParking(
  deps: { escalator: SpecEscalator },
  projectId: string,
  entry: MergeQueueEntry,
  outcome: Extract<MergeDriveOutcome, { kind: "needs_attention" }>,
): Promise<SettleParkAction> {
  if (outcome.parking === "complete") {
    return { action: "dequeue", reason: "needs_attention", message: outcome.message };
  }
  if (outcome.parking === "terminal_noop") {
    return { action: "dequeue", reason: "superseded", message: outcome.message };
  }
  if (outcome.parking === "parking_failed") {
    return { action: "retain", message: outcome.message };
  }
  const park = await deps.escalator.escalate({ projectId, entry, message: outcome.message });
  return settleFromEscalateOutcome(park, outcome.message);
}

/**
 * After a writer-rework router returns owned/parked/terminal_noop/parking_*, prove the
 * NEW owner or settle the park disposition truthfully.
 */
export async function settleWriterOwnedOrPark(
  deps: { recoveryEvidence?: RecoveryEvidencePort; escalator: SpecEscalator },
  projectId: string,
  culprit: MergeQueueEntry,
  recovery: GateReworkRouteResult | ConflictRecoveryDisposition,
  ownedMessage: string,
  contextMessage: string,
): Promise<SettleParkAction> {
  if (recovery.kind === "parked") {
    return { action: "dequeue", reason: "needs_attention", message: recovery.message };
  }
  if (recovery.kind === "terminal_noop") {
    return { action: "dequeue", reason: "superseded", message: recovery.message };
  }
  if (recovery.kind === "parking_failed") {
    return { action: "retain", message: recovery.message };
  }
  if (recovery.kind === "parking_required") {
    const park = await deps.escalator.escalate({
      projectId,
      entry: culprit,
      message: recovery.message,
    });
    return settleFromEscalateOutcome(park, recovery.message);
  }
  const verified = await verifyRecoveryOwnership({
    evidence: deps.recoveryEvidence,
    expectedSpecId: culprit.specId,
    receipt: recovery.receipt,
    contextMessage,
  });
  if (!verified.ok) {
    const park = await deps.escalator.escalate({ projectId, entry: culprit, message: verified.message });
    return settleFromEscalateOutcome(park, verified.message);
  }
  return { action: "dequeue", reason: "superseded", message: ownedMessage };
}
