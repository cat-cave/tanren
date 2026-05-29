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
  cacheFreshnessMs: 60 * 60 * 1000,
};
