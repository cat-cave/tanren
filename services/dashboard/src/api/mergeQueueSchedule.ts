import { OrchestratorHttpClient } from "./httpClient.js";

export interface MergeQueueSchedulePartition {
  readonly queueId: string;
  readonly runId: string;
  readonly specId: string;
  readonly fingerprint: string;
  readonly classes: readonly string[];
  readonly conservative: boolean;
}

export interface MergeQueueScheduleLease {
  readonly partitionId: string;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
  readonly generation: number;
  readonly fingerprint: string;
}

export interface MergeQueueScheduleResponse {
  readonly schedule: {
    readonly selectedCap: number;
    readonly selectedRunIds: readonly string[];
    readonly blockers: readonly string[];
    readonly conservativeInput: string;
    readonly partitions: readonly MergeQueueSchedulePartition[];
    readonly activeLeases: readonly MergeQueueScheduleLease[];
  };
}

export class MergeQueueScheduleClient extends OrchestratorHttpClient {
  public async getSchedule(orgId: string, projectId: string): Promise<MergeQueueScheduleResponse | undefined> {
    return await this.getJson<MergeQueueScheduleResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/merge-queue/schedule`,
    );
  }
}
