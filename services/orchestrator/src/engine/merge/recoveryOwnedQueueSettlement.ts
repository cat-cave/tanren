// Batch-owned recovery settlement through the sole atomic success authority.
// Missing/malformed/stale evidence may route to the existing atomic park;
// transport/commit uncertainty only retains and redrives.

import type { ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";
import type { DequeueReason, MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { RecoveryOwnedSettleOutcome, RecoveryOwnedSettlementWriter } from "../contracts/runStateWriter.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { settleFromParkOutcome } from "./parkSettle.js";

export type OwnedQueueSettle =
  | { action: "dequeue"; reason: DequeueReason; message: string; alreadyDequeued?: boolean }
  | { action: "retain"; message: string; retryAfterMs: number };

export async function settleOwnedRecoveryOrPark(input: {
  recoverySettlement: RecoveryOwnedSettlementWriter | undefined;
  escalator: SpecEscalator;
  projectId: string;
  entry: MergeQueueEntry;
  receipt: ConflictRecoveryReceipt;
  reason: Extract<DequeueReason, "conflict" | "superseded">;
  ownedMessage: string;
  contextMessage: string;
}): Promise<OwnedQueueSettle> {
  let outcome: RecoveryOwnedSettleOutcome | undefined;
  if (input.recoverySettlement !== undefined) {
    outcome = await input.recoverySettlement.settleOwnedRecoveryAndDequeue({
      orgId: input.entry.orgId,
      projectId: input.entry.projectId,
      queueId: input.entry.queueId,
      runId: input.entry.runId,
      specId: input.entry.specId,
      receipt: input.receipt,
      reason: input.reason,
      message: input.ownedMessage,
    });
  }
  if (outcome?.kind === "settled") {
    return {
      action: "dequeue",
      reason: input.reason,
      message: input.ownedMessage,
      alreadyDequeued: true,
    };
  }

  const failureMessage =
    outcome === undefined
      ? `recovery ownership cannot be atomically settled for ${input.entry.specId}: no settlement authority is wired: ${input.contextMessage}`
      : `recovery ownership could not be atomically settled for ${input.entry.specId} (${outcome.reason}): ${input.contextMessage}`;
  if (outcome !== undefined && !(outcome.reason === "evidence_invalid" && outcome.queueDisposition === "retained")) {
    return { action: "retain", message: failureMessage, retryAfterMs: outcome.retryAfterMs };
  }

  const park = await input.escalator.escalate({
    projectId: input.projectId,
    entry: input.entry,
    message: failureMessage,
  });
  const settled = settleFromParkOutcome(park, failureMessage);
  if (settled.action === "retain") return settled;
  return {
    action: "dequeue",
    reason: "needs_attention",
    message: settled.message,
    alreadyDequeued: settled.alreadyDequeued === true,
  };
}
