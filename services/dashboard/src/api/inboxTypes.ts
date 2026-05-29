/**
 * P3-0022 candidate-inbox client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/inbox` contracts. Kept in their own module (the
 * shared `types.ts` is at the 500-line cap) so the inbox surface owns its data
 * shapes — the P2B integration isolation lesson (parallel client-touching
 * screens get their own api modules).
 */

export type SourceKind = "issues" | "errors" | "system" | "manual" | "scheduled_audit";

export type TriageVerdict = "auto_routable" | "needs_call" | "dedupe_close";

export type CandidateStatus =
  | "new"
  | "triaged"
  | "auto_routed"
  | "accepted"
  | "folded"
  | "dismissed"
  | "closed_duplicate";

export interface InboxSource {
  id: string;
  orgId: string;
  projectId: string | null;
  kind: SourceKind;
  name: string;
  detail: string;
  config: Record<string, unknown>;
  enabled: boolean;
  autoRoute: boolean;
}

export interface CandidateTriage {
  dedupe: string;
  match: string;
  placement: string;
  verdict: TriageVerdict;
  duplicateOfSpecId: string | null;
  discoveryVariant: "feature" | "bug" | "strategic";
}

export interface Candidate {
  id: string;
  sourceId: string;
  orgId: string;
  projectId: string | null;
  externalId: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "fail";
  status: CandidateStatus;
  triage: CandidateTriage | null;
  resolvedSpecId: string | null;
  sourceName: string;
  sourceKind: SourceKind;
}

export interface InboxSnapshot {
  sources: InboxSource[];
  candidates: Candidate[];
}
