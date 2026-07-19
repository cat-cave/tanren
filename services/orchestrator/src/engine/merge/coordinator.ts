// Pure merge-queue settlement helpers (event emitter types + markDequeuedAfterEvent).
// Production merge passes use BatchMergeCoordinator; EventEmittingMergeCoordinator is deleted.

import type { DequeueReason, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { MergeDriveOutcome } from "../contracts/mergeCoordinator.js";
import type { WatchdogProgressSignal } from "../contracts/commandSubstrate.js";

/**
 * Drives ONE queued run's merge through the existing per-run merge path. The
 * worker boot supplies this as a closure over `mergeForRun` in `native_queue`
 * DRIVE mode so this module does not import the heavy run-loop seam graph.
 */
export type DriveMergeForQueuedRun = (input: {
  runId: string;
  projectId: string;
  onWatchdogProgress?: (signal: WatchdogProgressSignal) => void;
  claimSignal?: AbortSignal;
  confirmClaimBeforeLand?: () => Promise<boolean>;
}) => Promise<MergeDriveOutcome>;

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
  emitPartitionLeased(input: {
    projectId: string;
    entry: MergeQueueEntry;
    partitionId: string;
    leaseOwner: string;
    leaseHeartbeatAt: Date;
    generation: number;
    scopeFingerprint?: string;
  }): Promise<void>;
  emitPartitionReleased(input: {
    projectId: string;
    entry: MergeQueueEntry;
    partitionId: string;
    leaseOwner: string;
    generation: number;
  }): Promise<void>;
  emitMemberIsolated(input: {
    projectId: string;
    entry: MergeQueueEntry;
    partitionId: string;
    groupId: string;
    memberId: string;
    reason: "audit_policy" | "member_gate" | "behavior_proof" | "design_proof";
    findingIds: string[];
  }): Promise<void>;
}

/**
 * Queue/event ordering shared by both writer planes. Recovery-owned and park paths
 * bypass this helper because their writer authority commits event+queue atomically.
 */
export async function markDequeuedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  reason: DequeueReason;
  message: string;
}): Promise<void> {
  await input.events.emitDequeued({
    projectId: input.projectId,
    entry: input.entry,
    reason: input.reason,
    message: input.message,
  });
  await input.queue.markDequeued(input.entry.queueId, input.reason);
}
