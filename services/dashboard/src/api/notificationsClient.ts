/**
 * Notification matrix / delivery / target client surface, split out of
 * `orchestrator.ts` so the product client stays under the 500-line architecture
 * cap (same split rationale as `recoveryClient.ts` / `orgConfigClient.ts`).
 * Lands on `OrchestratorClient` via inheritance.
 */

import { OrchestratorOrgConfigClient } from "./orgConfigClient.js";
import type {
  NotificationDeliveriesResponse,
  NotificationDelivery,
  NotificationMatrix,
  NotificationRoute,
  NotificationTarget,
} from "./types.js";

export abstract class OrchestratorNotificationsClient extends OrchestratorOrgConfigClient {
  /** The full notifications matrix for an org. Empty on failure. */
  async notificationMatrix(orgId: string): Promise<NotificationMatrix> {
    const json = await this.getJson<NotificationMatrix>(`/orgs/${encodeURIComponent(orgId)}/notifications/matrix`);
    return json ?? { targets: [], routes: [], events: [] };
  }

  /** Recent notification dispatch attempts for the org. Empty on failure. */
  async notificationDeliveries(orgId: string, limit = 24): Promise<NotificationDelivery[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    const json = await this.getJson<NotificationDeliveriesResponse>(
      `/orgs/${encodeURIComponent(orgId)}/notifications/deliveries?${query.toString()}`,
    );
    return json?.deliveries ?? [];
  }

  /** Create a notification target. */
  async createNotificationTarget(
    orgId: string,
    body: Record<string, unknown>,
  ): Promise<NotificationTarget | undefined> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/notifications/targets`, body);
    if (!result.ok) return undefined;
    return result.body as NotificationTarget;
  }

  /** Patch quiet posture (weekendMute / enabled) on an existing target. */
  async updateNotificationTarget(
    orgId: string,
    targetId: string,
    body: { weekendMute?: boolean; enabled?: boolean },
  ): Promise<NotificationTarget | undefined> {
    const result = await this.sendJson(
      "PATCH",
      `/orgs/${encodeURIComponent(orgId)}/notifications/targets/${encodeURIComponent(targetId)}`,
      body,
    );
    if (!result.ok) return undefined;
    return result.body as NotificationTarget;
  }

  /** Create/replace a notification route opt-in. */
  async createNotificationRoute(orgId: string, body: Record<string, unknown>): Promise<NotificationRoute | undefined> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/notifications/routes`, body);
    if (!result.ok) return undefined;
    return result.body as NotificationRoute;
  }
}
