// barrel.

export {
  CiFlakyPayload,
  Insight,
  InsightAction,
  InsightKind,
  InsightPayload,
  InsightSeverity,
  ModelMismatchPayload,
  PaceAnomalyPayload,
  RetryHotspotPayload,
  ReviewStallPayload,
  StuckPayload,
} from "./types.js";

export { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";

export {
  computeInsight,
  loadInsightsForProject,
  INSIGHT_KINDS,
  type ComputeInsightContext,
  type LoadInsightsOptions,
  type ReadThroughInsightKind,
} from "./computer.js";

export { computeRetryHotspot } from "./retryHotspot.js";
export { computeModelMismatch } from "./modelMismatch.js";
export { computePaceAnomaly } from "./paceAnomaly.js";
export { computeStuck } from "./stuck.js";
export { computeReviewStall } from "./reviewStall.js";

// Mergify parity (autonomy-engine.md §2d) + CI-intelligence PR2.
export {
  detectAndQuarantineFlaky,
  deriveFlakyTests,
  loadCiObservations,
  loadCiTestObservations,
  flattenCiObservations,
  type CiCheckObservation,
  type FlakyVerdict,
  type DetectFlakyContext,
} from "./ciFlaky.js";
export {
  deriveFlakyTestsPerTest,
  deriveTestDurationProfiles,
  type CiTestObservation,
  type FlakyTestVerdict,
  type TestDurationProfile,
  type DurationProfileOptions,
} from "./ciFlakyTests.js";
export { surfaceActiveQuarantines } from "./ciFlakySurface.js";
export {
  computeCiAnalytics,
  deriveCiAnalytics,
  reduceGateVerdictsToRuns,
  CiAnalytics,
  type CiRunObservation,
  type CiAnalyticsInputs,
} from "./ci/index.js";
export {
  computeQueueStats,
  deriveQueueStats,
  normalizeQueueEvent,
  QueueStats,
  type QueueEvent,
  type DependencyEdge,
  type QueueStatsInputs,
} from "./queue/index.js";

export {
  readFreshInsights,
  readFreshOrCompute,
  writeInsights,
  acknowledgeInsight,
  type ReadOrComputeOptions,
} from "./cache.js";
