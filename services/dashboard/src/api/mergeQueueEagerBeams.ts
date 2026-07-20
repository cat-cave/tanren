import { OrchestratorHttpClient } from "./httpClient.js";

export interface EagerBeamMember {
  readonly specId: string;
  readonly runId: string;
  readonly branch: string;
  readonly headSha: string;
}

export interface EagerBeamSummary {
  readonly id: string;
  readonly frontierRunId: string;
  readonly frontierSpecId: string;
  readonly planDigest: string | null;
  readonly integrationNodeId: string | null;
  readonly rank: number;
  readonly generation: number;
  readonly state: "building" | "ready" | "stale" | "held";
  readonly staleReason: string | null;
  readonly updatedAt: string;
  readonly evidenceState: "exact" | "not_built" | "unavailable";
  readonly baseSha?: string;
  readonly members?: readonly EagerBeamMember[];
  readonly nodeStatus?: "building" | "ready" | "landed" | "stale";
  readonly proofRoot?: string | null;
}

export interface MergeQueueEagerBeamsResponse {
  readonly beams: readonly EagerBeamSummary[];
}

export class MergeQueueEagerBeamsClient extends OrchestratorHttpClient {
  public async listEagerBeams(orgId: string, projectId: string): Promise<MergeQueueEagerBeamsResponse | undefined> {
    return await this.getJson<MergeQueueEagerBeamsResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/merge-queue/eager-beams`,
    );
  }
}
