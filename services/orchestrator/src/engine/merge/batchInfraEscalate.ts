// v54 finding #56: when the merge-queue's batch-check repeatedly fails on the SAME
// signature (sustained-non-recovery from `BatchInfraHoldCeiling`), the failure is no
// longer a "transient infra blip" — it is a deterministic defect in the spec the
// writer just authored (a `just bootstrap` that fails in a fresh workspace, a missing
// devDependency, etc.). The doctrine-compliant response is to STOP soft-looping and
// ESCALATE the batch back to the WRITER for rework, identical in shape to the
// gate-fail-strand fix `settleBisectCulprit` applies to a bisect culprit.
//
// This module owns that escalation path: emit a TERMINAL `merge.batch.infra_blocked`
// (audit lineage) with `disposition: "escalated_to_writer"`, then for each entry route
// `routeGateFailToRework` (the existing DAG re-author primitive), then dequeue
// `superseded` only with a writer-run receipt; a router-owned park dequeues
// `needs_attention`. The infra-hold streak is CLEARED so a recovered queue starts fresh.
//
// No `gateRework` wired (a degenerate assembly) → the caller falls back to
// `terminalInfraBlock` (the prior loud-halt behavior).

import type { BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import { markDequeuedAfterEvent, type MergeQueueEventEmitter, type MergeSettleTransaction } from "./coordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";
import type { BatchInfraHoldCeiling } from "./batchInfraHoldCeiling.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");

/** The streak-count attribution shown on the escalation event (audit telemetry). */
const ESCALATION_ATTEMPTS = 1;

export interface EscalateInfraHoldArgs {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  batchEvents: BatchMergeEventEmitter;
  gateRework: BatchGateReworkRouter;
  ceiling: BatchInfraHoldCeiling;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  holds: number;
  queueDepth: number;
  tx?: MergeSettleTransaction;
}

/**
 * Escalate a sustained-non-recovering batch infra hold by routing every member to the
 * writer rework (one `routeGateFailToRework` per culprit, carrying the bootstrap
 * failure as steering). The typed receipt determines whether the old entry was
 * superseded by live rework or parked at needs_attention.
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
    await markDequeuedAfterEvent({
      queue: args.queue,
      events: args.events,
      projectId: args.projectId,
      entry,
      reason: recovery.kind === "owned" ? "superseded" : "needs_attention",
      message:
        recovery.kind === "owned"
          ? `routed to writer rework on sustained merge-queue workspace/infra failure: ${args.message}`
          : recovery.message,
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

// Synthesize a gate-error string the writer rework can act on. The message format
// mirrors what `settleBisectCulprit` passes for a real gate-fail, with the merge-queue
// streak context up front so the writer's planner reads it as a deterministic defect.
function synthesizeGateErrorFromInfra(message: string, holds: number): string {
  return (
    `MERGE QUEUE WORKSPACE/INFRA FAILURE (sustained across ${holds} re-drives in a fresh workspace).\n` +
    `The pre-merge batch check could not bootstrap the workspace from a clean checkout. ` +
    `This is treated as a deterministic scaffold defect (the local writer iterations passed only ` +
    `because the workspace was already primed); the rework must reproduce + fix the cold-start path.\n\n` +
    `Original failure:\n${message}`
  );
}
