import { OrchestratorHttpClient } from "./httpClient.js";

export type MultiMemberAuthorityKind =
  | "authorized_subset"
  | "member_failure"
  | "interaction_failure"
  | "flake_observation"
  | "transient_infrastructure"
  | "needs_product_decision"
  | "unknown_fail_closed";

export type MultiMemberAuthorityDisposition = "admit" | "exclude" | "hold" | "bisect";

export type MultiMemberAuthoritySource = "merge.signal.classified" | "authority_decision" | "batch_gate" | "quarantine";

/** One member in the exact persisted evaluation order. Null identity fields were not durably linked. */
export interface MergeQueueAuthorityMemberOutcome {
  readonly ordinal: number;
  readonly specId: string;
  readonly runId: string | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly disposition: MultiMemberAuthorityDisposition;
  readonly findingIds: string[];
  readonly reasonCodes: string[];
}

/** Durable MQ-2 read model. It is never synthesized from an in-process authorization result. */
export interface MergeQueueAuthorityEvaluation {
  readonly evaluationId: string;
  readonly groupId: string;
  readonly kind: MultiMemberAuthorityKind;
  readonly observedAt: string;
  readonly source: MultiMemberAuthoritySource;
  readonly sourceId: string;
  readonly nodeId: string | null;
  readonly memberSetHash: string | null;
  readonly proofReuseKey: string | null;
  readonly members: MergeQueueAuthorityMemberOutcome[];
  readonly reasonCodes: string[];
  /** Aggregate durable finding identity; event-only rows do not invent per-member attribution. */
  readonly findingIds: string[];
  readonly eligibleMemberIds: string[];
}

export interface MergeQueueAuthorityEvaluationsListResponse {
  readonly latestEvaluationId: string | null;
  readonly evaluations: MergeQueueAuthorityEvaluation[];
}

export interface MergeQueueAuthorityEvaluationDetailResponse {
  readonly evaluation: MergeQueueAuthorityEvaluation;
}

/** Typed client for the discoverable collection and exact durable MQ-2 evaluation. */
export class MergeQueueAuthorityEvaluationsClient extends OrchestratorHttpClient {
  async listAuthorityEvaluations(
    orgId: string,
    projectId: string,
    limit = 20,
  ): Promise<MergeQueueAuthorityEvaluationsListResponse | undefined> {
    return await this.getJson<MergeQueueAuthorityEvaluationsListResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/authority-evaluations?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async getAuthorityEvaluation(
    orgId: string,
    projectId: string,
    evaluationId: string,
  ): Promise<MergeQueueAuthorityEvaluationDetailResponse | undefined> {
    return await this.getJson<MergeQueueAuthorityEvaluationDetailResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/authority-evaluations/${encodeURIComponent(evaluationId)}`,
    );
  }
}
