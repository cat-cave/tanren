export interface Notification {
  channel: "ntfy" | "email" | "webhook";
  payload: Record<string, unknown>;
}

export interface NotificationOutbox {
  enqueue(notification: Notification): Promise<{ id: string }>;
}

export class FakeNotificationOutbox implements NotificationOutbox {
  readonly notifications: Notification[] = [];

  async enqueue(notification: Notification): Promise<{ id: string }> {
    this.notifications.push(notification);
    return { id: `notification_${this.notifications.length}` };
  }
}
