// v54 finding #56: when the merge-queue's batch-check repeatedly fails on the SAME
// signature (sustained-non-recovery from `BatchInfraHoldCeiling`), the failure is no
// longer a "transient infra blip" — it is a deterministic defect in the spec the
// writer just authored. Escalate the batch back to the WRITER for rework, then
// settlement-time store-verify each WriterRecoveryReceipt before superseding.

import type { BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import {
  markDequeuedAfterEvent,
  type MergeQueueEventEmitter,
  type MergeSettleTransaction,
} from "./mergeQueueSettle.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";
import type { BatchInfraHoldCeiling } from "./batchInfraHoldCeiling.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { settleWriterOwnedOrPark } from "./batchCoordinatorSettle.js";
import type { RecoveryEvidencePort } from "./recoveryOwnership.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");

/** The streak-count attribution shown on the escalation event (audit telemetry). */
const ESCALATION_ATTEMPTS = 1;

export interface EscalateInfraHoldArgs {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  batchEvents: BatchMergeEventEmitter;
  gateRework: BatchGateReworkRouter;
  escalator: SpecEscalator;
  ceiling: BatchInfraHoldCeiling;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  holds: number;
  queueDepth: number;
  tx?: MergeSettleTransaction;
  /** Settlement-time proof of the NEW owner run+task (never the stale PR/head). */
  recoveryEvidence?: RecoveryEvidencePort;
}

/**
 * Escalate a sustained-non-recovering batch infra hold by routing every member to the
 * writer rework. Owned receipts must pass store readback before the old entry is
 * superseded; otherwise park needs_attention.
 */
export async function escalateInfraHoldToWriter(args: EscalateInfraHoldArgs): Promise<CoordinateResult> {
  const gateError = synthesizeGateErrorFromInfra(args.message, args.holds);
  await args.batchEvents.emitInfraBlocked({
    projectId: args.projectId,
    batch: args.batch,
    message: `sustained workspace/infra failure escalated to writer rework after ${args.holds} re-drives: ${args.message}`,
    attempts: ESCALATION_ATTEMPTS,
    terminal: true,
    consecutiveHolds: args.holds,
  });
  for (const entry of args.batch) {
    const recovery = await args.gateRework.routeGateFailToRework({
      projectId: args.projectId,
      culprit: entry,
      gateError,
    });
    const settled = await settleWriterOwnedOrPark(
      { recoveryEvidence: args.recoveryEvidence, escalator: args.escalator },
      args.projectId,
      entry,
      recovery,
      `routed to writer rework on sustained merge-queue workspace/infra failure: ${args.message}`,
      args.message,
    );
    await markDequeuedAfterEvent({
      queue: args.queue,
      events: args.events,
      projectId: args.projectId,
      entry,
      reason: settled.reason,
      message: settled.message,
      ...(args.tx === undefined ? {} : { tx: args.tx }),
    });
  }
  await args.ceiling.reset(args.projectId);
  log.warn("batch escalated to writer rework on sustained merge-queue infra non-recovery", {
    projectId: args.projectId,
    holds: args.holds,
    members: args.batch.length,
    message: args.message,
  });
  return { projectId: args.projectId, holdReason: "all_blocked", queueDepth: args.queueDepth };
}

function synthesizeGateErrorFromInfra(message: string, holds: number): string {
  return (
    `MERGE QUEUE WORKSPACE/INFRA FAILURE (sustained across ${holds} re-drives in a fresh workspace).\n` +
    `The pre-merge batch check could not bootstrap the workspace from a clean checkout. ` +
    `This is treated as a deterministic scaffold defect (the local writer iterations passed only ` +
    `because the workspace was already primed); the rework must reproduce + fix the cold-start path.\n\n` +
    `Original failure:\n${message}`
  );
}
