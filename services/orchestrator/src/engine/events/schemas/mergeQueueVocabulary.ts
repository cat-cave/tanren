import {
  MergeBatchBisectingPayload,
  MergeBatchCheckingPayload,
  MergeBatchCulpritPayload,
  MergeBatchGateReworkRoutedPayload,
  MergeBatchInfraBlockedPayload,
  MergeBatchPassedPayload,
  MergeDequeuedPayload,
  MergeQueueAdvancedPayload,
  MergeQueueInfraBlockedPayload,
  MergeReGateGateReworkRoutedPayload,
} from "./mergeQueue.js";

export const mergeQueueEventRegistry = {
  "merge.queue.advanced": MergeQueueAdvancedPayload,
  "merge.dequeued": MergeDequeuedPayload,
  "merge.queue.infra_blocked": MergeQueueInfraBlockedPayload,
  "merge.batch.checking": MergeBatchCheckingPayload,
  "merge.batch.passed": MergeBatchPassedPayload,
  "merge.batch.bisecting": MergeBatchBisectingPayload,
  "merge.batch.culprit": MergeBatchCulpritPayload,
  "merge.batch.gate_rework_routed": MergeBatchGateReworkRoutedPayload,
  "merge.regate.gate_rework_routed": MergeReGateGateReworkRoutedPayload,
  "merge.batch.infra_blocked": MergeBatchInfraBlockedPayload,
} as const;
