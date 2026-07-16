// v54 finding #56: sustained-non-recovery batch infra → escalate each member to
// writer rework (or atomic park when no durable owner). Never fabricate ownership.

import type { BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { RecoveryOwnedSettlementWriter } from "../contracts/runStateWriter.js";
import { markDequeuedAfterEvent, type MergeQueueEventEmitter } from "./coordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";
import type { BatchInfraHoldCeiling } from "./batchInfraHoldCeiling.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { isClassifiedMemberPolicyMessage } from "./authoritySignalClassification.js";
import { settleFromParkOutcome } from "./parkSettle.js";
import { settleOwnedRecoveryOrPark } from "./recoveryOwnedQueueSettlement.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");
const ESCALATION_ATTEMPTS = 1;

export interface EscalateInfraHoldArgs {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  batchEvents: BatchMergeEventEmitter;
  gateRework: BatchGateReworkRouter;
  escalator: SpecEscalator;
  recoverySettlement?: RecoveryOwnedSettlementWriter;
  ceiling: BatchInfraHoldCeiling;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  holds: number;
  queueDepth: number;
}

export async function escalateInfraHoldToWriter(args: EscalateInfraHoldArgs): Promise<CoordinateResult> {
  // mq-1: never reclassify a classified member-policy batch as workspace infra escalation.
  if (isClassifiedMemberPolicyMessage(args.message)) {
    log.error("refusing batch infra escalation for classified member-policy authority block", {
      projectId: args.projectId,
      message: args.message,
      members: args.batch.length,
    });
    await args.ceiling.reset(args.projectId);
    return { projectId: args.projectId, holdReason: "all_blocked", queueDepth: args.queueDepth };
  }
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
    if (recovery.kind === "owned") {
      const settled = await settleOwnedRecoveryOrPark({
        recoverySettlement: args.recoverySettlement,
        escalator: args.escalator,
        projectId: args.projectId,
        entry,
        receipt: recovery.receipt,
        reason: "superseded",
        ownedMessage: `routed to writer rework on sustained merge-queue workspace/infra failure: ${args.message}`,
        contextMessage: gateError,
      });
      if (settled.action === "retain") {
        await args.queue.releaseClaim(entry.queueId);
        continue;
      }
      if (settled.alreadyDequeued !== true) {
        await markDequeuedAfterEvent({
          queue: args.queue,
          events: args.events,
          projectId: args.projectId,
          entry,
          reason: settled.reason,
          message: settled.message,
        });
      }
      continue;
    }
    if (recovery.kind === "terminal_noop") {
      await markDequeuedAfterEvent({
        queue: args.queue,
        events: args.events,
        projectId: args.projectId,
        entry,
        reason: "superseded",
        message: recovery.message,
      });
      continue;
    }
    // parking_required | parking_failed
    const message = recovery.kind === "parking_failed" ? recovery.message : recovery.message;
    if (recovery.kind === "parking_failed") {
      await args.queue.releaseClaim(entry.queueId);
      continue;
    }
    const park = await args.escalator.escalate({ projectId: args.projectId, entry, message });
    const settled = settleFromParkOutcome(park, message);
    if (settled.action === "retain") {
      await args.queue.releaseClaim(entry.queueId);
      continue;
    }
    if (!settled.alreadyDequeued) {
      await markDequeuedAfterEvent({
        queue: args.queue,
        events: args.events,
        projectId: args.projectId,
        entry,
        reason: settled.reason,
        message: settled.message,
      });
    }
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
