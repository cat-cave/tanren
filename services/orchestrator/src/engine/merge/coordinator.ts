// Pure merge-queue settlement helpers (event emitter types + markDequeuedAfterEvent).
// Production merge passes use BatchMergeCoordinator; EventEmittingMergeCoordinator is deleted.

import type { DequeueReason, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { MergeDriveOutcome } from "../contracts/mergeCoordinator.js";

/**
 * Drives ONE queued run's merge through the existing per-run merge path. The
 * worker boot supplies this as a closure over `mergeForRun` in `native_queue`
 * DRIVE mode so this module does not import the heavy run-loop seam graph.
 */
export type DriveMergeForQueuedRun = (input: { runId: string; projectId: string }) => Promise<MergeDriveOutcome>;

/** What the coordinator needs to emit the queue events (org-scoped, eventStore). */
export interface MergeQueueEventEmitter {
  /** merge.queue.advanced: the coordinator selected the DAG-ordered head to merge. */
  emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void>;
  /** merge.dequeued: an entry left the queue without merging. */
  emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: DequeueReason;
    message: string;
  }): Promise<void>;
  /**
   * merge.queue.infra_blocked: a transient merge-drive infra error could no longer
   * continue on the short retry — loud operator-visible alert/halt.
   */
  emitInfraBlocked(input: {
    projectId: string;
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous" | "missing_required_credential";
    attempts: number;
    message: string;
  }): Promise<void>;
}

/**
 * Both-or-neither settle transaction (audit RC-4 #3). Event append + queue UPDATE
 * run on one org-scoped transaction when wired.
 */
export interface MergeSettleTransaction {
  run(
    projectId: string,
    work: (ctx: { events: MergeQueueEventEmitter; queue: MergeQueueModel }) => Promise<void>,
  ): Promise<void>;
}

/**
 * Queue/event split-brain guard + atomicity: terminal dequeue is never durable before
 * its event; with a MergeSettleTransaction both writes commit or roll back together.
 */
export async function markDequeuedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  reason: DequeueReason;
  message: string;
  tx?: MergeSettleTransaction;
}): Promise<void> {
  const settle = async (events: MergeQueueEventEmitter, queue: MergeQueueModel): Promise<void> => {
    await events.emitDequeued({
      projectId: input.projectId,
      entry: input.entry,
      reason: input.reason,
      message: input.message,
    });
    await queue.markDequeued(input.entry.queueId, input.reason);
  };
  if (input.tx !== undefined) {
    await input.tx.run(input.projectId, (ctx) => settle(ctx.events, ctx.queue));
    return;
  }
  await settle(input.events, input.queue);
}
