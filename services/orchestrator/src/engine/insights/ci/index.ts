// P2e-1 CI analytics barrel (autonomy-engine.md §2d Mergify parity).

export { CiAnalytics, CiCheckStat, CiTimingStat } from "./types.js";
export {
  computeCiAnalytics,
  deriveCiAnalytics,
  reduceCiEventsToRuns,
  type CiAnalyticsInputs,
  type CiRunObservation,
  type DeriveCiOptions,
  type ComputeCiAnalyticsOptions,
} from "./compute.js";
