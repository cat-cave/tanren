import {
  JobLeaseExpiredPayload,
  RunCancelledPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunQueuedPayload,
  RunStartedPayload,
  SpecCancelledPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskQueuedPayload,
  TaskStartedPayload,
  windowPauseEventRegistry,
} from "./lifecycle.js";

export const lifecycleEventRegistry = {
  "run.queued": RunQueuedPayload,
  "run.started": RunStartedPayload,
  "run.completed": RunCompletedPayload,
  "run.failed": RunFailedPayload,
  ...windowPauseEventRegistry,
  "task.queued": TaskQueuedPayload,
  "task.started": TaskStartedPayload,
  "task.completed": TaskCompletedPayload,
  "task.failed": TaskFailedPayload,
  "job.lease_expired": JobLeaseExpiredPayload,
  "spec.cancelled": SpecCancelledPayload,
  "run.cancelled": RunCancelledPayload,
} as const;
