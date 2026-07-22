import {
  MergeBatchBisectingPayload,
  MergeBatchCheckingPayload,
  MergeBatchGateReworkRoutedPayload,
  MergeBatchInfraBlockedPayload,
  MergeBatchPassedPayload,
  MergeBeamPlannedPayload,
  MergeBeamStalePayload,
  MergeDequeuedPayload,
  MergeQueueAdvancedPayload,
  MergeQueueInfraBlockedPayload,
  MergeReGateGateReworkRoutedPayload,
} from "./mergeQueue.js";
import { queuePolicyEventRegistry } from "./queuePolicyVocabulary.js";

export const mergeQueueEventRegistry = {
  "merge.queue.advanced": MergeQueueAdvancedPayload,
  "merge.dequeued": MergeDequeuedPayload,
  "merge.queue.infra_blocked": MergeQueueInfraBlockedPayload,
  "merge.batch.checking": MergeBatchCheckingPayload,
  "merge.batch.passed": MergeBatchPassedPayload,
  "merge.batch.bisecting": MergeBatchBisectingPayload,
  "merge.batch.gate_rework_routed": MergeBatchGateReworkRoutedPayload,
  "merge.regate.gate_rework_routed": MergeReGateGateReworkRoutedPayload,
  "merge.batch.infra_blocked": MergeBatchInfraBlockedPayload,
  "merge.beam.planned": MergeBeamPlannedPayload,
  "merge.beam.stale": MergeBeamStalePayload,
  ...queuePolicyEventRegistry,
} as const;
