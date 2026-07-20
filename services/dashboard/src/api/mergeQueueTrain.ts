/**
 * mq-15 merge-train client. A STANDALONE client over the shared HTTP transport
 * (the merge-queue screen-isolation lesson). Two reads map 1:1 onto the orchestrator
 * routes:
 *   train    → GET /orgs/:orgId/projects/:projectId/merge-queue/train
 *   artifact → GET /orgs/:orgId/projects/:projectId/merge-queue/land-groups/:groupId/artifact
 * `getJson` swallows read failures to `undefined`, so the panel degrades to `unknown`
 * (never green) rather than throwing on a transient read error.
 */

import { OrchestratorHttpClient } from "./httpClient.js";

/** One sealed train's list summary (a subset of the strict manifest, for the panel). */
export interface MergeTrainArtifactSummary {
  readonly id: string;
  readonly landGroupId: string;
  readonly authorityDecisionId: string;
  readonly integrationNodeId: string;
  readonly proofRoot: string;
  readonly receiptMainSha: string;
  readonly deployDeploymentId: string;
  readonly demoSurfaceKind: string;
  readonly demoBehaviorCount: number;
  readonly demoPassed: number;
  readonly bundleDigest: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface MergeTrainMember {
  readonly ordinal: number;
  readonly memberKey: string;
  readonly runId: string;
  readonly specId: string;
  readonly prNumber: number | null;
}

export interface MergeTrainArtifact {
  readonly version: 1;
  readonly schemaVersion: "merge_train_artifact.v1";
  readonly orgId: string;
  readonly projectId: string;
  readonly landGroupId: string;
  readonly authorityDecisionId: string;
  readonly integrationNodeId: string;
  readonly proofRoot: string;
  readonly receipt: { readonly mainSha: string; readonly auditId: string };
  readonly members: readonly MergeTrainMember[];
  readonly deploy: {
    readonly provider: string;
    readonly appId: string;
    readonly deploymentId: string;
    readonly url: string;
    readonly state: string;
  };
  readonly demo: {
    readonly surfaceKind: string;
    readonly behaviorCount: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly sealedBundle: {
    readonly bundleId: string;
    readonly bundleDigest: string;
    readonly proofRoot: string;
    readonly bytesDigest: string;
    readonly signingKeyId: string;
    readonly rootSignatureHex: string;
  };
  readonly contentHash: string;
}

export interface MergeTrainListResponse {
  readonly artifacts: MergeTrainArtifactSummary[];
}

export class MergeQueueTrainClient extends OrchestratorHttpClient {
  /** The project's sealed trains, newest first; undefined on read failure. */
  async listTrain(orgId: string, projectId: string, limit?: number): Promise<MergeTrainListResponse | undefined> {
    const qs = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.getJson<MergeTrainListResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/merge-queue/train${qs}`,
    );
  }

  /** One exact land-group artifact's strict manifest; undefined on read failure / absent. */
  async getArtifact(orgId: string, projectId: string, landGroupId: string): Promise<MergeTrainArtifact | undefined> {
    const json = await this.getJson<{ artifact: MergeTrainArtifact }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/land-groups/${encodeURIComponent(landGroupId)}/artifact`,
    );
    return json?.artifact;
  }
}
