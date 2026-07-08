/**
 * Merge-queue client. A STANDALONE client over the shared HTTP transport
 * (`OrchestratorHttpClient`) — not folded into the product `OrchestratorClient`
 * chain — so the merge-queue surface owns its own api module (the screen-isolation
 * lesson). Two reads map 1:1 onto the orchestrator report routes:
 *   integration-metrics → GET /orgs/:orgId/projects/:projectId/integration-metrics
 *   queue-stats         → GET /orgs/:orgId/projects/:projectId/queue-stats
 * `getJson` swallows read failures to `undefined`, so each panel degrades to "—".
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { IntegrationMetrics, QueueStats } from "./mergeQueue.js";

export class MergeQueueClient extends OrchestratorHttpClient {
  /** Never-discard rebase metrics; undefined on read failure. */
  async getIntegrationMetrics(
    orgId: string,
    projectId: string,
    windowDays?: number,
  ): Promise<IntegrationMetrics | undefined> {
    const qs = windowDays === undefined ? "" : `?windowDays=${windowDays}`;
    const json = await this.getJson<{ metrics?: IntegrationMetrics }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/integration-metrics${qs}`,
    );
    return json?.metrics;
  }

  /** Native merge-queue statistics; undefined on read failure. */
  async getQueueStats(orgId: string, projectId: string, windowDays?: number): Promise<QueueStats | undefined> {
    const qs = windowDays === undefined ? "" : `?windowDays=${windowDays}`;
    const json = await this.getJson<{ stats?: QueueStats }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/queue-stats${qs}`,
    );
    return json?.stats;
  }
}
