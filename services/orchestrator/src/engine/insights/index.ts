// P2A-0020 barrel.

export {
  Insight,
  InsightAction,
  InsightKind,
  InsightPayload,
  InsightSeverity,
  ModelMismatchPayload,
  PaceAnomalyPayload,
  RetryHotspotPayload
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

export {
  readFreshInsights,
  readFreshOrCompute,
  writeInsights,
  acknowledgeInsight,
  type ReadOrComputeOptions
} from "./cache.js";
