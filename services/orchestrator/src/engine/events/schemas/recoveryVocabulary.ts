import {
  RecoveryInspectionOpenedPayload,
  RecoveryReplanQueuedPayload,
  RecoveryReviseRoutedPayload,
  RecoveryRollbackQueuedPayload,
} from "./recovery.js";

export const recoveryEventRegistry = {
  "recovery.revise_routed": RecoveryReviseRoutedPayload,
  "recovery.replan_queued": RecoveryReplanQueuedPayload,
  "recovery.rollback_queued": RecoveryRollbackQueuedPayload,
  "recovery.inspection_opened": RecoveryInspectionOpenedPayload,
} as const;
