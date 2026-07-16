import { OrchestratorHttpClient } from "./httpClient.js";

interface AuthoritySignalIdentity {
  readonly missionNodeId: "mq-1";
  readonly evaluationId: string;
  readonly groupId: string;
  readonly signalVersion: "merge_signal.v1";
  readonly memberIds: string[];
  readonly findingIds: string[];
}

export type MergeQueueAuthoritySignal = AuthoritySignalIdentity &
  (
    | {
        readonly classification: "deterministic_policy";
        readonly reasonCode: "audit_policy";
        readonly retryability: "non_retryable";
        readonly wakeKey: null;
        readonly disposition: "member_repair";
      }
    | {
        readonly classification: "transient_infrastructure";
        readonly reasonCode:
          | "provider_timeout"
          | "provider_rate_limit"
          | "runner_unavailable"
          | "runner_transport"
          | "code_host_unavailable"
          | "gate_infrastructure";
        readonly retryability: "retryable";
        readonly wakeKey: string;
        readonly disposition: "retry_when_ready";
      }
    | {
        readonly classification: "needs_product_decision";
        readonly reasonCode: "review_changes_requested" | "hitl_pending";
        readonly retryability: "non_retryable";
        readonly wakeKey: string;
        readonly disposition: "await_product_decision";
      }
    | {
        readonly classification: "unknown_fail_closed";
        readonly reasonCode:
          | "untyped_evidence"
          | "unattributed_policy"
          | "contradictory_evidence"
          | "invalid_binding"
          | "unclassified_authority_block";
        readonly retryability: "unknown";
        readonly wakeKey: null;
        readonly disposition: "hold_fail_closed";
      }
  );

export interface MergeQueueAuthoritySignalProjection {
  readonly eventId: string;
  readonly observedAt: string;
  readonly signal: MergeQueueAuthoritySignal;
}

export interface MergeQueueAuthoritySignalsListResponse {
  readonly latestEvaluationId: string | null;
  readonly signals: MergeQueueAuthoritySignalProjection[];
}

export interface MergeQueueAuthorityEvaluationResponse {
  readonly evaluationId: string;
  readonly signals: MergeQueueAuthoritySignalProjection[];
}

/** Typed client for the latest/discoverable and exact-evaluation read surfaces. */
export class MergeQueueAuthoritySignalsClient extends OrchestratorHttpClient {
  async listAuthoritySignals(
    orgId: string,
    projectId: string,
    limit = 20,
  ): Promise<MergeQueueAuthoritySignalsListResponse | undefined> {
    return await this.getJson<MergeQueueAuthoritySignalsListResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/authority-signals?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async getEvaluationSignals(
    orgId: string,
    projectId: string,
    evaluationId: string,
  ): Promise<MergeQueueAuthorityEvaluationResponse | undefined> {
    return await this.getJson<MergeQueueAuthorityEvaluationResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/evaluations/${encodeURIComponent(evaluationId)}/signals`,
    );
  }
}
