/**
 * P3-0021 scheduled-audits client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/audits` contracts. Kept in their own module (the
 * shared `types.ts` is at the 500-line cap) so the audits surface owns its data
 * shapes — the P2B integration isolation lesson (parallel client-touching
 * screens get their own api modules).
 */

export type AuditKind = "security" | "deps" | "a11y" | "mutation" | "perf" | "license" | "stale_specs";

export type AuditCadence = "nightly" | "weekly" | "monthly";

export type AuditFindingSeverity = "ok" | "info" | "warn" | "fail" | "off";

export interface AuditFindingsSummary {
  count: number;
  severity: AuditFindingSeverity;
  note: string;
}

export interface AuditJob {
  id: string;
  orgId: string;
  projectId: string | null;
  kind: AuditKind;
  name: string;
  cadence: AuditCadence;
  targetWindow: string;
  answererCli: string;
  enabled: boolean;
  lastRun: string | null;
  findings: AuditFindingsSummary;
}

export interface AuditRecommendation {
  kind: AuditKind;
  name: string;
  why: string;
  window: string;
  cadence: AuditCadence;
}

export interface AuditsSnapshot {
  jobs: AuditJob[];
  recommended: AuditRecommendation[];
}

export interface CreateAuditJobInput {
  kind: AuditKind;
  name: string;
  cadence: AuditCadence;
  projectId: string | null;
  targetWindow: string;
  answererCli: string;
  enabled?: boolean;
}
