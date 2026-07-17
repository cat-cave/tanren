import { OrchestratorHttpClient } from "./httpClient.js";

export interface IntegrationEvent {
  id: string;
  ts: string;
  projectId: string;
  eventType: string;
  payload: unknown;
  redactedPaths: string[];
}

export interface IntegrationEventsRead {
  projectId: string;
  events: IntegrationEvent[];
}

/** Read-only client for the project-scoped integration event timeline. */
export class IntegrationEventsClient extends OrchestratorHttpClient {
  async list(orgId: string, projectId: string, limit = 50): Promise<IntegrationEventsRead | undefined> {
    return this.getJson<IntegrationEventsRead>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/integration-events?limit=${limit}`,
    );
  }
}
