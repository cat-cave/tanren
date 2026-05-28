// P2A-0020 barrel.

export {
  Insight,
  InsightAction,
  InsightKind,
  InsightPayload,
  InsightSeverity,
  ModelMismatchPayload,
  PaceAnomalyPayload,
  RetryHotspotPayload,
  ReviewStallPayload,
  StuckPayload
} from "./types.js";

export { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";

export {
  computeInsight,
  loadInsightsForProject,
  INSIGHT_KINDS,
  type ComputeInsightContext,
  type LoadInsightsOptions
} from "./computer.js";

export { computeRetryHotspot } from "./retryHotspot.js";
export { computeModelMismatch } from "./modelMismatch.js";
export { computePaceAnomaly } from "./paceAnomaly.js";
export { computeStuck } from "./stuck.js";
export { computeReviewStall } from "./reviewStall.js";

export {
  readFreshInsights,
  readFreshOrCompute,
  writeInsights,
  acknowledgeInsight,
  type ReadOrComputeOptions
} from "./cache.js";
