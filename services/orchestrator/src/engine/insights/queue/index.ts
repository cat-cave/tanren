// P2e-1 queue/stack statistics barrel (autonomy-engine.md §2d Mergify parity).

export { QueueStats, QueueDepthPoint } from "./types.js";
export {
  computeQueueStats,
  deriveQueueStats,
  normalizeQueueEvent,
  type QueueEvent,
  type DependencyEdge,
  type QueueStatsInputs,
  type DeriveQueueOptions,
  type ComputeQueueStatsOptions,
} from "./compute.js";
