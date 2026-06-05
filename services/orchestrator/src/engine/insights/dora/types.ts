// DORA-like delivery metrics — type definitions.
//
// The four DORA metrics, REPORTED not targeted, derived from data that runs,
// tasks, and events already persist (no new collection, no migration):
//
//   - lead time          — median spec.created → merge.completed, per merged run
//   - deploy frequency    — merge.completed events per day over the window
//   - change failure rate — share of finished runs that halted/failed
//   - MTTR                — median halt → recovery (the next merge.completed for
//                           the same spec after a halt) over the window
//
// Every figure is honest about absence: when there is no data to compute a
// metric (no merges, no halts), the value is `null` and the panel renders "—"
// rather than a fabricated zero. Counts that are genuinely zero (e.g. zero
// failures across N finished runs) stay numeric.

import { z } from "zod";

/** A single DORA metric figure plus the sample it was computed from. */
export const DoraMetricFigure = z
  .object({
    /** The headline value in the metric's native unit; null when uncomputable. */
    value: z.number().nullable(),
    /** Sample size the figure was computed from (merges, runs, recoveries). */
    sample: z.number().int().nonnegative(),
  })
  .strict();
export type DoraMetricFigure = z.infer<typeof DoraMetricFigure>;

export const DoraMetrics = z
  .object({
    projectId: z.string().min(1),
    /** Inclusive lower bound of the observation window (ISO). */
    windowStart: z.string(),
    /** Upper bound of the observation window — "now" at compute time (ISO). */
    windowEnd: z.string(),
    windowDays: z.number().int().positive(),
    /** Median spec→merge lead time in seconds. */
    leadTimeSeconds: DoraMetricFigure,
    /** Merges per day across the window (merges / windowDays). */
    deployFrequencyPerDay: DoraMetricFigure,
    /** Fraction [0,1] of finished runs that did not succeed. */
    changeFailureRate: DoraMetricFigure,
    /** Median halt→recovery time in seconds. */
    meanTimeToRestoreSeconds: DoraMetricFigure,
    /** Convenience totals for the panel sub-lines. */
    totals: z
      .object({
        merges: z.number().int().nonnegative(),
        finishedRuns: z.number().int().nonnegative(),
        failedRuns: z.number().int().nonnegative(),
        recoveries: z.number().int().nonnegative(),
      })
      .strict(),
    computedAt: z.string(),
  })
  .strict();
export type DoraMetrics = z.infer<typeof DoraMetrics>;
