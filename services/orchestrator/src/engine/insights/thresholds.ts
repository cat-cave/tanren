// thresholds. Each constant is the documented v0 default. Per-PROJECT
// overrides ride the project-config `insightThresholds` field (a governed
// SETTING, exactly like `auditPosture`/`reviewPolicy`/`governancePosture` —
// never an env var); call sites already receive the resolved bag through
// `deps.thresholds`, so the per-project shape that arrives here is a
// `Partial<InsightThresholds>` layered on top of `DEFAULT_THRESHOLDS`. See
// docs/architecture/insights.md.

import { z } from "zod";

export interface InsightThresholds {
  // retry_hotspot
  retryHotspotMinAttempts: number;
  retryHotspotWindowDays: number;
  // model_mismatch
  modelMismatchWindowDays: number;
  modelMismatchMinMergedPerModel: number;
  modelMismatchCostRatio: number;
  // pace_anomaly
  paceAnomalyMultiplier: number;
  paceAnomalyWindowDays: number;
  paceAnomalyMinSamples: number;
  // review_stall. `stuck` needs no threshold — it is a pure
  // graph-reachability check over current spec statuses.
  reviewStallHours: number;
  // The lookback window (days) that BOUNDS the review-event SELECT. A stall is
  // only meaningful within recent history; this caps an otherwise lifetime-wide
  // scan of every review/merge event for the project. Generous relative to
  // `reviewStallHours` (48h) so no real stall is missed.
  reviewStallWindowDays: number;
  // ci_flaky. `flakyMinToggledShas` is the SAFETY bar: a check must show
  // a pass+fail toggle on at least this many distinct head SHAs to be
  // quarantined (default 1 — a single proven non-determinism). Raising it
  // demands repeated flakes. `flakyWindowDays` bounds the observation lookback.
  flakyMinToggledShas: number;
  flakyWindowDays: number;
  // ci_insights GENERATIVE loop (PR3). The recurrence bars before the loop emits a
  // DURABLE-FIX candidate (a spec) for a recurring CI problem — anti-spam: a fix is
  // generated only for a PROVEN problem, never per flaky run.
  // `ciInsightFlakyMinShas`: a flaky test must be proven on at least this many
  //   distinct toggled SHAs before a fix-spec is generated (>= the quarantine bar).
  //   An autonomous project may set this to 1 via the project-config
  //   `insightThresholds` field so a single-run flake is spec-eligible (the
  //   autonomy doctrine: an autonomous run has no operator to notice a
  //   quarantine awaiting a second-SHA recurrence).
  // `ciInsightSlowMinSuiteTests`: a suite needs at least this many slow tests before
  //   a "split/parallelize the suite" candidate is worth a spec (a single slow test
  //   is a test-level fix, not a suite split).
  ciInsightFlakyMinShas: number;
  ciInsightSlowMinSuiteTests: number;
  // cache freshness
  cacheFreshnessMs: number;
}

export const DEFAULT_THRESHOLDS: InsightThresholds = {
  retryHotspotMinAttempts: 2,
  retryHotspotWindowDays: 7,
  modelMismatchWindowDays: 30,
  modelMismatchMinMergedPerModel: 3,
  modelMismatchCostRatio: 2,
  paceAnomalyMultiplier: 2,
  paceAnomalyWindowDays: 30,
  paceAnomalyMinSamples: 3,
  reviewStallHours: 48,
  reviewStallWindowDays: 30,
  flakyMinToggledShas: 1,
  flakyWindowDays: 14,
  // A durable fix-spec is generated only for a repeatedly-flaky test (proven on >= 2
  // distinct SHAs) — a higher bar than the quarantine floor (1), so a one-off flake
  // is quarantined but not yet specced. A suite needs >= 2 slow tests to be worth a split.
  ciInsightFlakyMinShas: 2,
  ciInsightSlowMinSuiteTests: 2,
  cacheFreshnessMs: 60 * 60 * 1000,
};

// The per-project INSIGHT-THRESHOLDS config — a governed SETTING (lives in the
// project config jsonb), exactly like `auditPosture`/`reviewPolicy`. Every field
// is optional: a present value overrides the corresponding `DEFAULT_THRESHOLDS`
// entry; an absent field inherits the default. The autonomous-project pattern is
// to set `ciInsightFlakyMinShas: 1` so a single-run flake is spec-eligible (the
// audit→fix→ship loop closes without waiting for a second-SHA recurrence that may
// never arrive within an autonomous run). Stored as `Partial<InsightThresholds>`;
// the run-time emitter layers the persisted overrides on top of `DEFAULT_THRESHOLDS`.
export const InsightThresholdsConfig = z
  .object({
    retryHotspotMinAttempts: z.number().int().min(1).optional(),
    retryHotspotWindowDays: z.number().int().min(1).optional(),
    modelMismatchWindowDays: z.number().int().min(1).optional(),
    modelMismatchMinMergedPerModel: z.number().int().min(1).optional(),
    modelMismatchCostRatio: z.number().positive().optional(),
    paceAnomalyMultiplier: z.number().positive().optional(),
    paceAnomalyWindowDays: z.number().int().min(1).optional(),
    paceAnomalyMinSamples: z.number().int().min(1).optional(),
    reviewStallHours: z.number().positive().optional(),
    reviewStallWindowDays: z.number().int().min(1).optional(),
    flakyMinToggledShas: z.number().int().min(1).optional(),
    flakyWindowDays: z.number().int().min(1).optional(),
    ciInsightFlakyMinShas: z.number().int().min(1).optional(),
    ciInsightSlowMinSuiteTests: z.number().int().min(1).optional(),
    cacheFreshnessMs: z.number().int().min(0).optional(),
  })
  .strict();
export type InsightThresholdsConfig = z.infer<typeof InsightThresholdsConfig>;
