// Dependency-neutral merge-queue settle helpers: event-first dequeue / infra-block
// with optional both-or-neither transaction. Extracted so coordinators and settle
// mapping can share them without an import cycle (coordinator ↔ batchCoordinatorSettle).

import type { DequeueReason, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";

/** What the coordinator needs to emit the queue events (org-scoped, eventStore). */
export interface MergeQueueEventEmitter {
  /** merge.queue.advanced: the coordinator selected the DAG-ordered head to merge. */
  emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void>;
  /** merge.dequeued: an entry left the queue without merging (conflict/blocked/failed/superseded). */
  emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: DequeueReason;
    message: string;
  }): Promise<void>;
  /**
   * merge.queue.infra_blocked (GAP #2d): a transient merge-drive infra error could no
   * longer continue on the short retry — the entry exhausted its re-drive ceiling, or
   * the merge state was unconfirmable (auto-retry could double-merge). A LOUD
   * operator-visible alert/halt.
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
 * ATOMICITY SEAM (audit RC-4 #3): both-or-neither settle transaction for event append +
 * queue UPDATE. Event-first ordering is preserved inside the transaction.
 */
export interface MergeSettleTransaction {
  run(
    projectId: string,
    work: (ctx: { events: MergeQueueEventEmitter; queue: MergeQueueModel }) => Promise<void>,
  ): Promise<void>;
}

/**
 * Terminal dequeue: durable event first, then row UPDATE. With a {@link MergeSettleTransaction}
 * both run in one txn; without it, sequential event-first still holds.
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

/** Infra-blocked halt: durable event first, then dequeue as blocked. */
export async function markInfraBlockedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  kind: "ceiling" | "ambiguous" | "missing_required_credential";
  attempts: number;
  message: string;
  tx?: MergeSettleTransaction;
}): Promise<void> {
  const settle = async (events: MergeQueueEventEmitter, queue: MergeQueueModel): Promise<void> => {
    await events.emitInfraBlocked({
      projectId: input.projectId,
      entry: input.entry,
      kind: input.kind,
      attempts: input.attempts,
      message: input.message,
    });
    await queue.markDequeued(input.entry.queueId, "blocked");
  };
  if (input.tx !== undefined) {
    await input.tx.run(input.projectId, (ctx) => settle(ctx.events, ctx.queue));
    return;
  }
  await settle(input.events, input.queue);
}
