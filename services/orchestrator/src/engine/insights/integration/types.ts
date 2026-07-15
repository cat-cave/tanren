// Integration `rebase_vs_rebuild` metrics — type definitions
// (tanren-owns-the-engine.md §3/§7/§8 — the never-discard read-side).
//
// The never-discard BaseShiftCoordinator emits one `integration.rebase` event
// per base shift it handled, carrying a CATEGORICAL `decision` (the recorded
// signal) — NOT a token/wall-clock figure. This read-side JOINS the cost of each
// rebased run AT READ TIME (`cost_records` summed by `run_id`, `runs` wall-clock =
// `ended_at - started_at`) so it never widens the event payload. The headline is
// the `rebase_vs_rebuild` comparison: the cost of work KEPT ALIVE by a rebase
// (clean/resolved) vs. the cost of work that had to be re-planned (`replanned`),
// proving rebase < rebuild.
//
// Every figure is honest about absence: a bucket with no rows reports `null`
// medians (and the panel renders "—") rather than a fabricated zero. Counts that
// are genuinely zero stay numeric.

import { z } from "zod";

/** Recorded base-shift outcomes — the `integration.rebase` `decision` (incl. writer/park). */
export const RebaseDecisionValues = [
  "rebased_clean",
  "rebased_resolved",
  "replanned",
  "writer_rework",
  "parked",
  "held",
] as const;
export const RebaseDecision = z.enum(RebaseDecisionValues);
export type RebaseDecision = z.infer<typeof RebaseDecision>;

/** A per-`decision` bucket: how many shifts landed there + their joined cost. */
export const IntegrationDecisionBucket = z
  .object({
    /** How many `integration.rebase` events recorded this `decision` in the window. */
    count: z.number().int().nonnegative(),
    /** Median total LLM tokens across the bucket's rebased runs; null when none had cost. */
    medianTokens: z.number().nullable(),
    /** Sample size the `medianTokens` figure was computed from (runs with cost rows). */
    tokensSample: z.number().int().nonnegative(),
    /** Median run wall-clock (`ended_at - started_at`) in seconds; null when uncomputable. */
    medianWallClockSeconds: z.number().nullable(),
    /** Sample size the `medianWallClockSeconds` figure was computed from. */
    wallClockSample: z.number().int().nonnegative(),
  })
  .strict();
export type IntegrationDecisionBucket = z.infer<typeof IntegrationDecisionBucket>;

/**
 * The headline `rebase_vs_rebuild` comparison: the median token cost of work a
 * rebase KEPT ALIVE (`rebased_clean` + `rebased_resolved`) vs. the median token
 * cost of work that had to be re-planned (`replanned` — the rebuild). When
 * `keptAlive < replanned`, the never-discard rebase paid off.
 */
export const RebaseVsRebuild = z
  .object({
    /** Median tokens across all kept-alive (clean + resolved) rebased runs; null when none. */
    keptAliveMedianTokens: z.number().nullable(),
    /** Sample size behind `keptAliveMedianTokens`. */
    keptAliveSample: z.number().int().nonnegative(),
    /** Median tokens across all `replanned` (rebuilt) runs; null when none. */
    replannedMedianTokens: z.number().nullable(),
    /** Sample size behind `replannedMedianTokens`. */
    replannedSample: z.number().int().nonnegative(),
    /**
     * True when both medians exist AND kept-alive < replanned — the proof that
     * rebase < rebuild. null when either side has no sample (no comparison possible).
     */
    rebaseCheaper: z.boolean().nullable(),
  })
  .strict();
export type RebaseVsRebuild = z.infer<typeof RebaseVsRebuild>;

export const IntegrationMetrics = z
  .object({
    projectId: z.string().min(1),
    /** Inclusive lower bound of the observation window (ISO). */
    windowStart: z.string(),
    /** Upper bound of the observation window — "now" at compute time (ISO). */
    windowEnd: z.string(),
    windowDays: z.number().int().positive(),
    /**
     * Per-`decision` buckets — exhaustive over every {@link RebaseDecision}.
     * No decision is silently dropped; counts partition totalRebases.
     */
    buckets: z
      .object({
        rebased_clean: IntegrationDecisionBucket,
        rebased_resolved: IntegrationDecisionBucket,
        replanned: IntegrationDecisionBucket,
        writer_rework: IntegrationDecisionBucket,
        parked: IntegrationDecisionBucket,
        held: IntegrationDecisionBucket,
      })
      .strict(),
    /** The headline `rebase < rebuild` comparison. */
    rebaseVsRebuild: RebaseVsRebuild,
    /** How many `integration.proof.reused` events fired in the window (least-repeated-work). */
    proofReuseCount: z.number().int().nonnegative(),
    /**
     * Denominator: count of known-decision `integration.rebase` events in the window.
     * Equals the sum of all bucket counts (every RebaseDecision has a bucket).
     * Unknown payload decisions are excluded rather than silently lost from buckets
     * while still inflating the total.
     */
    totalRebases: z.number().int().nonnegative(),
    computedAt: z.string(),
  })
  .strict();
export type IntegrationMetrics = z.infer<typeof IntegrationMetrics>;
