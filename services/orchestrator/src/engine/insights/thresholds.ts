// P2A-0020 thresholds. Each constant is the documented v0 default. Phase 3
// makes these per-org-configurable; the contract for that future migration
// is: `Thresholds` becomes a function of `orgId` and the call sites already
// receive the resolved bag so no compute-function signature changes. See
// docs/architecture/insights.md.

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
  // review_stall (P3-0020). `stuck` needs no threshold — it is a pure
  // graph-reachability check over current spec statuses.
  reviewStallHours: number;
  // ci_flaky (P2e-1). `flakyMinToggledShas` is the SAFETY bar: a check must show
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
  flakyMinToggledShas: 1,
  flakyWindowDays: 14,
  // A durable fix-spec is generated only for a repeatedly-flaky test (proven on >= 2
  // distinct SHAs) — a higher bar than the quarantine floor (1), so a one-off flake
  // is quarantined but not yet specced. A suite needs >= 2 slow tests to be worth a split.
  ciInsightFlakyMinShas: 2,
  ciInsightSlowMinSuiteTests: 2,
  cacheFreshnessMs: 60 * 60 * 1000,
};
