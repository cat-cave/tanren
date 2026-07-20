// mq-12 read-only client for one integration node's F2 evidence selection.

import { OrchestratorHttpClient } from "./httpClient.js";

export interface MergeQueueEvidenceContractResponse {
  readonly resolutionStatus: "selected" | "selected_contract_unavailable" | "full_gate_fallback" | "unavailable";
  readonly contract: {
    readonly schemaVersion: "fragment_evidence.v1";
    readonly junitReportPath: string;
    readonly testSelector: { readonly path: string; readonly format: "json" };
    readonly behaviorManifest: { readonly path: string; readonly format: "json" };
    readonly contentDigest: string;
  } | null;
  readonly proofUnit: {
    readonly id: string;
    readonly inputHash: string;
    readonly artifactDigest: string | null;
    readonly verdict: "pass" | "fail" | "skipped";
  } | null;
  readonly fallback: string | null;
}

export class MergeQueueEvidenceContractsClient extends OrchestratorHttpClient {
  async getEvidenceContract(
    orgId: string,
    projectId: string,
    nodeId: string,
  ): Promise<MergeQueueEvidenceContractResponse | undefined> {
    return await this.getJson<MergeQueueEvidenceContractResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/evidence-contracts/${encodeURIComponent(nodeId)}`,
    );
  }
}
