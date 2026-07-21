/**
 * mq-13 land-group delivery client. A STANDALONE client over the shared HTTP transport
 * (the merge-queue screen-isolation lesson). Two reads map 1:1 onto the orchestrator routes:
 *   list     → GET /orgs/:orgId/projects/:projectId/merge-queue/land-group-deliveries
 *   delivery → GET /orgs/:orgId/projects/:projectId/merge-queue/land-groups/:landGroupId/delivery
 * `getJson` swallows read failures to `undefined`, so the panel degrades to `unknown`
 * (never green) rather than throwing on a transient read error.
 */

import { OrchestratorHttpClient } from "./httpClient.js";

export interface LandGroupDeliveryReceipt {
  readonly version: 1;
  readonly schemaVersion: "land_group_delivery.v1";
  readonly orgId: string;
  readonly projectId: string;
  readonly landGroupId: string;
  readonly mainSha: string;
  readonly memberRunIds: readonly string[];
  readonly artifactDigest: string | null;
  readonly previewReleaseInstanceId: string | null;
  readonly productionReleaseInstanceId: string | null;
  readonly rollbackReleaseInstanceId: string | null;
  readonly state: string;
  readonly disposition: string;
  readonly attributedRunId: string | null;
  readonly idempotencyKey: string;
}

export interface LandGroupDeliverySummary {
  readonly id: string;
  readonly landGroupId: string;
  readonly projectId: string;
  readonly mainSha: string;
  readonly state: string;
  readonly disposition: string;
  readonly artifactDigest: string | null;
  readonly previewReleaseInstanceId: string | null;
  readonly productionReleaseInstanceId: string | null;
  readonly rollbackReleaseInstanceId: string | null;
  readonly attributedRunId: string | null;
  readonly receipt: LandGroupDeliveryReceipt | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LandGroupDeliveryListResponse {
  readonly deliveries: LandGroupDeliverySummary[];
}

export class MergeQueueGroupDeliveryClient extends OrchestratorHttpClient {
  /** The project's land-group deliveries, newest first; undefined on read failure. */
  async listDeliveries(
    orgId: string,
    projectId: string,
    limit?: number,
  ): Promise<LandGroupDeliveryListResponse | undefined> {
    const qs = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.getJson<LandGroupDeliveryListResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/merge-queue/land-group-deliveries${qs}`,
    );
  }

  /** One land-group delivery timeline; undefined on read failure / absent. */
  async getDelivery(
    orgId: string,
    projectId: string,
    landGroupId: string,
  ): Promise<LandGroupDeliverySummary | undefined> {
    const json = await this.getJson<{ delivery: LandGroupDeliverySummary }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/land-groups/${encodeURIComponent(landGroupId)}/delivery`,
    );
    return json?.delivery;
  }
}
