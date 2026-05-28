/**
 * P3-0019 DORA-like delivery-metric response types. Kept in their own module
 * (not the shared `types.ts`) so the metrics surface owns its contract and the
 * shared type barrel stays under the 500-line cap. Mirrors the orchestrator
 * `DoraMetrics` schema returned by `GET .../dora`.
 */

/**
 * One DORA figure plus the sample it was computed from. `value` is `null` when
 * there is nothing to compute from (no merges, no halts) so the panel renders
 * "—" rather than a fabricated zero; a genuine zero (e.g. zero failures across
 * N finished runs) stays numeric.
 */
export interface DoraMetricFigure {
  value: number | null;
  sample: number;
}

/**
 * The four DORA metrics, REPORTED not targeted, derived from existing run/
 * event data over a time window (`GET .../dora`, P3-0019).
 */
export interface DoraMetrics {
  projectId: string;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  /** Median spec.created → merge.completed lead time, in seconds. */
  leadTimeSeconds: DoraMetricFigure;
  /** Merges per day across the window. */
  deployFrequencyPerDay: DoraMetricFigure;
  /** Fraction [0,1] of finished runs that did not succeed. */
  changeFailureRate: DoraMetricFigure;
  /** Median halt → recovery-merge time, in seconds. */
  meanTimeToRestoreSeconds: DoraMetricFigure;
  totals: { merges: number; finishedRuns: number; failedRuns: number; recoveries: number };
  computedAt: string;
}
