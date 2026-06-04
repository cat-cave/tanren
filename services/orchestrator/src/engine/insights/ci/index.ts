// Native-gate analytics barrel (CI-intelligence). Reduces the native
// `gate.verdict` events the in-loop gate persists into project CI analytics.

export { CiAnalytics, CiCheckStat, CiTimingStat } from "./types.js";
export {
  computeCiAnalytics,
  deriveCiAnalytics,
  reduceGateVerdictsToRuns,
  type CiAnalyticsInputs,
  type CiRunObservation,
  type DeriveCiOptions,
  type ComputeCiAnalyticsOptions,
} from "./compute.js";
