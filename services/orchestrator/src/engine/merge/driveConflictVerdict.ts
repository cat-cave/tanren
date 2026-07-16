// DriveConflictVerdict capture cell + mapping from typed router dispositions.
// Split from driveConflictResolve.ts to stay under the architecture line cap.

import type {
  ConflictRecoveryDisposition,
  ConflictRecoveryReceipt,
  ConflictRecoverySettlement,
  TerminalParkNoopStatus,
} from "../contracts/conflictResolution.js";
import type { MergeDriveOutcome } from "../contracts/mergeCoordinator.js";

/** The drive's autonomous disposition after the conflict resolver / gate-rework. */
export type DriveConflictDisposition = "resolved" | "replanned" | "escalate" | "yield";

/** A mutable single-shot capture cell threaded into the hook + read by the drive. */
export interface DriveConflictVerdict {
  disposition?: DriveConflictDisposition;
  /** The decision message surfaced on escalation (a product-decision ask, not an error). */
  message?: string;
  /** Durable owner receipt when disposition is replanned (owned only — never synthesized). */
  recovery?: ConflictRecoveryReceipt;
  /**
   * Settlement parking mode when disposition is escalate / a non-owned router result.
   * Absent on owned replanned. Defaults to `required` for bare escalate (fixed-point).
   */
  parking?: "required" | "terminal_noop" | "parking_failed";
  terminalStatus?: TerminalParkNoopStatus;
}

/**
 * Map a typed router disposition onto the drive verdict capture cell. Owned receipts
 * become replanned+recovery; parking_required / terminal_noop / parking_failed escalate
 * with truthful parking tokens — never a silent fabricated replanned ownership.
 */
export function applyRecoveryDispositionToVerdict(
  verdict: DriveConflictVerdict,
  recovery: ConflictRecoveryDisposition,
): void {
  if (recovery.kind === "owned") {
    verdict.disposition = "replanned";
    verdict.recovery = recovery.receipt;
    return;
  }
  verdict.disposition = "escalate";
  verdict.message = recovery.message;
  if (recovery.kind === "terminal_noop") {
    verdict.parking = "terminal_noop";
    verdict.terminalStatus = recovery.status;
    return;
  }
  if (recovery.kind === "parking_failed") {
    verdict.parking = "parking_failed";
    return;
  }
  verdict.parking = "required";
}

/** Map a base-shift settlement without attempting recovery a second time. */
export function driveOutcomeFromRecoverySettlement(
  settlement: ConflictRecoverySettlement,
  message: string,
): Exclude<MergeDriveOutcome, { kind: "merged" | "blocked" | "re_gate_pending" | "failed" }> {
  if (settlement.kind === "owned") {
    return { kind: "conflict", message, recovery: settlement.receipt };
  }
  if (settlement.kind === "parked") {
    return { kind: "needs_attention", message, parking: "complete" };
  }
  if (settlement.kind === "terminal_noop") {
    return { kind: "needs_attention", message, parking: "terminal_noop", terminalStatus: settlement.status };
  }
  return { kind: "needs_attention", message: settlement.message, parking: "parking_failed" };
}
