import { z } from "zod";
import { MergeIntegrationMode } from "./integrations.js";

// P2d (autonomy-engine.md §2d): the native intelligent merge queue. Under
// `native_queue`, a ready-to-merge run ENTERS Tanren's own queue instead of
// merging immediately; the MergeCoordinator then orders ready runs in DAG order
// (ancestor before dependent, priority within a layer) and SERIALIZES their merges
// (one at a time), driving the SAME per-run merge path. These events make the
// queue's decisions visible + feed queue/stack statistics.
//
//   - merge.queue.advanced  → the coordinator selected the next run to merge (the
//                             head of the DAG-ordered queue) and is driving its
//                             merge. Carries the queue depth + the chosen run's spec
//                             so the timeline shows WHY it was next.
//   - merge.dequeued        → a queue entry left the queue WITHOUT merging: it was
//                             routed back (conflict → recoverable hold) or removed
//                             so independent later items can proceed (liveness). The
//                             `reason` records which. NOT a merge — a dequeue.
//
// (merge.queued — the entry event — reuses MergeQueuedPayload with the
// `native_queue` integration; merge.completed reuses MergeCompletedPayload.)

export const MergeQueueAdvancedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose run the coordinator selected as the queue head this pass. */
    specId: z.string(),
    /** The queue depth (ready entries) at selection time, for queue statistics. */
    queueDepth: z.number().int().nonnegative(),
  })
  .strict();

export const MergeDequeuedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose entry left the queue. */
    specId: z.string(),
    /**
     * Why the entry was dequeued without merging:
     *   - `conflict`  — the merge hit a real conflict and was routed to the P2b
     *                   resolver / recoverable hold (re-queued on the next signal).
     *   - `blocked`   — a governance/posture or speculative hold removed it from the
     *                   head so independent later items can proceed (re-queued later).
     *   - `failed`    — the merge failed terminally; the entry is removed.
     */
    reason: z.enum(["conflict", "blocked", "failed"]),
    /** The human-readable detail of the dequeue (the merge-stage message). */
    message: z.string(),
  })
  .strict();
