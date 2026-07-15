import { OrchestratorHttpClient } from "./httpClient.js";

interface AuthoritySignalIdentity {
  missionNodeId: "mq-1";
  evaluationId: string;
  groupId: string;
  memberIds: string[];
  findingIds: string[];
  signalVersion: "merge_signal.v1";
  sourceEventId?: string;
}

export type MergeQueueAuthoritySignal = AuthoritySignalIdentity &
  (
    | {
        classification: "deterministic_policy";
        reasonCode: "audit_policy";
        retryability: "non_retryable";
        wakeKey: null;
        repairRoute: "writer_repair" | "respec";
      }
    | {
        classification: "transient_infrastructure";
        reasonCode:
          | "provider_timeout"
          | "provider_rate_limit"
          | "runner_unavailable"
          | "runner_transport"
          | "code_host_unavailable"
          | "gate_infrastructure";
        retryability: "retryable" | "non_retryable";
        wakeKey: string;
        repairRoute: null;
      }
    | {
        classification: "needs_product_decision";
        reasonCode: "review_changes_requested" | "hitl_pending";
        retryability: "non_retryable";
        wakeKey: string;
        repairRoute: null;
      }
    | {
        classification: "unknown_fail_closed";
        reasonCode: "untyped_error" | "unattributed_policy" | "contradictory_evidence";
        retryability: "unknown";
        wakeKey: null;
        repairRoute: null;
      }
  );

export interface MergeQueueAuthoritySignalProjection {
  eventId: string;
  observedAt: string;
  signal: MergeQueueAuthoritySignal;
}

export interface MergeQueueAuthoritySignalsResponse {
  evaluationId: string;
  signals: MergeQueueAuthoritySignalProjection[];
}

/** Standalone read client for the mq-1 durable authority-signal projection. */
export class MergeQueueAuthoritySignalsClient extends OrchestratorHttpClient {
  async getAuthoritySignals(
    orgId: string,
    projectId: string,
    evaluationId: string,
  ): Promise<MergeQueueAuthoritySignalsResponse | undefined> {
    return await this.getJson<MergeQueueAuthoritySignalsResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/evaluations/${encodeURIComponent(evaluationId)}/signals`,
    );
  }
}
