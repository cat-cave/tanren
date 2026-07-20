import { OrchestratorHttpClient } from "./httpClient.js";

export interface QueuePolicyRouteView {
  readonly name: string;
  readonly targetBranch: string;
  readonly priority: { readonly base: string };
  readonly partition: { readonly mode: string; readonly capacity: number; readonly batchLimit: number };
  readonly requiredWindows: readonly string[];
}

export interface MergeQueuePolicyResponse {
  readonly id: string;
  readonly version: number;
  readonly policy: { readonly schemaVersion: "queue_policy.v1"; readonly routes: readonly QueuePolicyRouteView[] };
  readonly compiledHash: string;
}

export interface QueueWindowView {
  readonly id: string;
  readonly name: string;
  readonly kind: "allow" | "blackout";
  readonly timezone: string;
  readonly scope: { readonly projectId: string; readonly targetBranch?: string };
  readonly intervals: readonly { readonly startsAt: string; readonly endsAt: string }[];
}

export interface MergeQueueWindowsResponse {
  readonly windows: readonly QueueWindowView[];
}

export class MergeQueuePolicyClient extends OrchestratorHttpClient {
  public async getPolicy(orgId: string, projectId: string): Promise<MergeQueuePolicyResponse | undefined> {
    return this.getJson<MergeQueuePolicyResponse>(this.base(orgId, projectId) + "/policy");
  }

  public async listWindows(orgId: string, projectId: string): Promise<MergeQueueWindowsResponse | undefined> {
    return this.getJson<MergeQueueWindowsResponse>(this.base(orgId, projectId) + "/windows");
  }

  public async applyCommand(
    orgId: string,
    projectId: string,
    command: unknown,
  ): Promise<{ ok: boolean; status: number }> {
    const result = await this.sendJson("POST", this.base(orgId, projectId) + "/commands", command);
    return { ok: result.ok, status: result.status };
  }

  private base(orgId: string, projectId: string): string {
    return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/merge-queue`;
  }
}
