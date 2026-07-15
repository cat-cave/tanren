// v54 finding #56: sustained-non-recovery batch infra → escalate each member to
// writer rework (or atomic park when no durable owner). Never fabricate ownership.

import type { BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import { markDequeuedAfterEvent, type MergeQueueEventEmitter, type MergeSettleTransaction } from "./coordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";
import type { BatchInfraHoldCeiling } from "./batchInfraHoldCeiling.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { settleFromParkOutcome } from "./parkSettle.js";
import { verifyRecoveryOwnership, type RecoveryEvidencePort } from "./recoveryOwnership.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");
const ESCALATION_ATTEMPTS = 1;

export interface EscalateInfraHoldArgs {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  batchEvents: BatchMergeEventEmitter;
  gateRework: BatchGateReworkRouter;
  escalator: SpecEscalator;
  recoveryEvidence?: RecoveryEvidencePort;
  ceiling: BatchInfraHoldCeiling;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  holds: number;
  queueDepth: number;
  tx?: MergeSettleTransaction;
}

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
    if (recovery.kind === "owned") {
      const verified = await verifyRecoveryOwnership({
        evidence: args.recoveryEvidence,
        expectedOrgId: entry.orgId,
        expectedProjectId: entry.projectId,
        expectedSpecId: entry.specId,
        receipt: recovery.receipt,
        contextMessage: gateError,
      });
      if (verified.ok) {
        await markDequeuedAfterEvent({
          queue: args.queue,
          events: args.events,
          projectId: args.projectId,
          entry,
          reason: "superseded",
          message: `routed to writer rework on sustained merge-queue workspace/infra failure: ${args.message}`,
          ...(args.tx === undefined ? {} : { tx: args.tx }),
        });
        continue;
      }
      const park = await args.escalator.escalate({
        projectId: args.projectId,
        entry,
        message: verified.message,
      });
      const settled = settleFromParkOutcome(park, verified.message);
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
          ...(args.tx === undefined ? {} : { tx: args.tx }),
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
        ...(args.tx === undefined ? {} : { tx: args.tx }),
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
        ...(args.tx === undefined ? {} : { tx: args.tx }),
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
