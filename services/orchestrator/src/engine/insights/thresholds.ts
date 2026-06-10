// thresholds. Each constant is the documented v0 default. Per-org
// configurability is a later option; the contract for it
// is: `Thresholds` becomes a function of `orgId` and the call sites already
// receive the resolved bag so no compute-function signature changes. See
// docs/architecture/insights.md.

import { isApexMode } from "../config/apexMode.js";

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

// The APEX-MODE recurrence bar for the CI-intelligence root-cause loop (Loop 4). An
// apex / autonomous run has NO operator to notice a quarantine that sits awaiting a
// SECOND-SHA recurrence that may never come within the run, so a single-run flake would
// be quarantined-but-never-specced — the flaky→root-cause→ship loop would silently fail
// to close. Lowering `ciInsightFlakyMinShas` to 1 makes intra-run flaky evidence
// SPEC-ELIGIBLE (a single proven non-determinism earns a durable fix-spec), so the loop
// closes on a live apex run. This is the ONLY field apex mode overrides; everything else
// stays the conservative default.
export const APEX_THRESHOLDS: InsightThresholds = {
  ...DEFAULT_THRESHOLDS,
  ciInsightFlakyMinShas: 1,
};

// Resolve the BASE insight thresholds for this run — APEX-MODE-AWARE (Loop 4
// self-config). Under apex mode the base is `APEX_THRESHOLDS` (a single-run flake is
// spec-eligible — `ciInsightFlakyMinShas: 1`); otherwise the conservative
// `DEFAULT_THRESHOLDS` (the 2-SHA recurrence bar). Per-org/project overrides still
// layer ON TOP of this base — apex only moves the DEFAULT, never the explicit override.
export function resolveInsightThresholds(): InsightThresholds {
  return isApexMode() ? APEX_THRESHOLDS : DEFAULT_THRESHOLDS;
}
