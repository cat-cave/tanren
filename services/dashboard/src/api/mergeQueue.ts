/**
 * Merge-queue surface response types. Kept in their own module (not the shared
 * `types.ts`) so the surface owns its contract and the shared type barrel stays
 * under the 500-line cap. Mirrors the orchestrator schemas returned by
 * `GET .../integration-metrics` (`IntegrationMetrics`) and `GET .../queue-stats`
 * (`QueueStats`) — the never-discard rebase read-side + the native merge queue's
 * own statistics. Every median is `number | null` (null → the panel renders "—"
 * rather than a fabricated zero); counts that are genuinely zero stay numeric.
 */

/** A per-`decision` base-shift bucket: how many shifts landed there + joined cost. */
export interface IntegrationDecisionBucket {
  count: number;
  /** Median total LLM tokens across the bucket's rebased runs; null when none had cost. */
  medianTokens: number | null;
  tokensSample: number;
  /** Median run wall-clock (`ended_at - started_at`) in seconds; null when uncomputable. */
  medianWallClockSeconds: number | null;
  wallClockSample: number;
}

/**
 * The headline `rebase_vs_rebuild` comparison: median token cost of work a rebase
 * KEPT ALIVE (clean + resolved) vs. the cost of work that had to be re-planned
 * (rebuilt). `rebaseCheaper` is true only when both medians exist and kept-alive
 * < replanned; null when either side has no sample.
 */
export interface RebaseVsRebuild {
  keptAliveMedianTokens: number | null;
  keptAliveSample: number;
  replannedMedianTokens: number | null;
  replannedSample: number;
  rebaseCheaper: boolean | null;
}

/** Never-discard rebase metrics over a window (`GET .../integration-metrics`). */
export interface IntegrationMetrics {
  projectId: string;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  buckets: {
    rebased_clean: IntegrationDecisionBucket;
    rebased_resolved: IntegrationDecisionBucket;
    replanned: IntegrationDecisionBucket;
    held: IntegrationDecisionBucket;
  };
  rebaseVsRebuild: RebaseVsRebuild;
  /** How many `integration.proof.reused` events fired in the window. */
  proofReuseCount: number;
  totalRebases: number;
  computedAt: string;
}

/** A point on the queue-depth-over-time series (depth at a selection instant). */
export interface QueueDepthPoint {
  /** ISO instant the coordinator selected a head. */
  at: string;
  depth: number;
}

/** Native merge-queue statistics over a window (`GET .../queue-stats`). */
export interface QueueStats {
  projectId: string;
  windowStart: string;
  windowEnd: string;
  windowDays: number;

  // queue depth
  /** Queue depth sampled at each coordinator selection, in time order. */
  depthSeries: QueueDepthPoint[];
  /** Max observed queue depth over the window; null when no selections. */
  maxDepth: number | null;
  /** Mean observed queue depth; null when no selections. */
  meanDepth: number | null;

  // time in queue
  medianTimeInQueueSeconds: number | null;
  maxTimeInQueueSeconds: number | null;
  timeInQueueSample: number;

  // batch / bisect
  batchesChecked: number;
  batchesPassed: number;
  /** passed/checked; null when no batches. */
  batchPassRate: number | null;
  batchesBisected: number;
  culpritsIsolated: number;

  // dequeues without merging, by reason
  dequeues: {
    conflict: number;
    blocked: number;
    failed: number;
    superseded: number;
  };

  /** Deepest dependency chain among specs that flowed through the queue. */
  maxStackDepth: number | null;

  computedAt: string;
}
