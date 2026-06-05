// queue/stack statistics types (autonomy-engine.md §2d). These surface what a
// managed merge-queue dashboard would — depth over time, time-in-queue, batch pass-rate, bisect /
// culprit counts, stack depth — derived purely from the native queue's OWN
// events. Language-neutral + schema-validated; pure compute, no write path.

import { z } from "zod";

/** A point on the queue-depth-over-time series (depth at a selection instant). */
export const QueueDepthPoint = z
  .object({
    /** ISO instant the coordinator selected a head (merge.queue.advanced). */
    at: z.string(),
    /** Queue depth (ready entries) reported at that selection. */
    depth: z.number().int().nonnegative(),
  })
  .strict();
export type QueueDepthPoint = z.infer<typeof QueueDepthPoint>;

export const QueueStats = z
  .object({
    projectId: z.string(),
    windowStart: z.string(),
    windowEnd: z.string(),
    windowDays: z.number().int().positive(),

    // --- queue depth ---------------------------------------------------------
    /** Queue depth sampled at each coordinator selection, in time order. */
    depthSeries: z.array(QueueDepthPoint),
    /** Max observed queue depth over the window; null when no selections. */
    maxDepth: z.number().int().nonnegative().nullable(),
    /** Mean observed queue depth; null when no selections. */
    meanDepth: z.number().nonnegative().nullable(),

    // --- time in queue -------------------------------------------------------
    /** Median seconds from merge.queued to the entry leaving (advanced/dequeued). */
    medianTimeInQueueSeconds: z.number().nonnegative().nullable(),
    /** Max time-in-queue seconds. */
    maxTimeInQueueSeconds: z.number().nonnegative().nullable(),
    /** Entries that contributed a time-in-queue sample (queued + resolved). */
    timeInQueueSample: z.number().int().nonnegative(),

    // --- batch / bisect ------------------------------------------------------
    /** Speculative batch checks formed (merge.batch.checking). */
    batchesChecked: z.number().int().nonnegative(),
    /** Batches whose speculative check passed (merge.batch.passed). */
    batchesPassed: z.number().int().nonnegative(),
    /** Batch pass-rate = passed/checked; null when no batches. */
    batchPassRate: z.number().min(0).max(1).nullable(),
    /** Batches that failed their check and were bisected (merge.batch.bisecting). */
    batchesBisected: z.number().int().nonnegative(),
    /** Offending PRs isolated by bisect (merge.batch.culprit). */
    culpritsIsolated: z.number().int().nonnegative(),
    /** Total speculative sub-batch checks the bisects performed (sum of `checks`). */
    bisectChecksPerformed: z.number().int().nonnegative(),

    // --- dequeues ------------------------------------------------------------
    /** Dequeues without merging, broken down by reason. */
    dequeues: z
      .object({
        conflict: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        /** Prior runs retired by a percolation re-execution (§2c supersede). */
        superseded: z.number().int().nonnegative(),
      })
      .strict(),

    // --- stack depth (DAG-derived) ------------------------------------------
    /** Deepest dependency chain among specs that flowed through the queue. */
    maxStackDepth: z.number().int().nonnegative().nullable(),

    computedAt: z.string(),
  })
  .strict();
export type QueueStats = z.infer<typeof QueueStats>;
