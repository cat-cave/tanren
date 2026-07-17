import {
  IntegrationProvisionedPayload,
  NotificationEnqueuedPayload,
  NotificationFailedPayload,
  NotificationSentPayload,
} from "./integrations.js";

export const notificationEventRegistry = {
  "notification.enqueued": NotificationEnqueuedPayload,
  "notification.sent": NotificationSentPayload,
  "notification.failed": NotificationFailedPayload,
  "integration.provisioned": IntegrationProvisionedPayload,
} as const;
