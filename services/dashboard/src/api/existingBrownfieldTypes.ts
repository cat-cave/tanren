/**
 * P3-0016 brownfield full-track client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/brownfield` recon/seed contracts + the
 * config-injection / governance route payloads. Kept in their own module (the
 * discovery/greenfield isolation lesson: parallel client-touching screens own
 * their own api modules so they never diverge a shared client).
 */

export type GovernancePosture = "strict" | "open" | "audit_only";

export interface ReconPersona {
  name: string;
  description: string;
  inferredFrom: string;
}

export interface ReconBehavior {
  persona: string;
  title: string;
  inferredFrom: string;
}

export interface ReconArchitectureLine {
  layer: string;
  detail: string;
}

export interface ReconRisk {
  severity: "info" | "warn" | "fail";
  note: string;
}

export interface ReconGap {
  id: string;
  chapter: string;
  question: string;
  options: string[];
}

export interface ReconReport {
  identity: { slug: string; purpose: string; inferredFrom: string };
  personas: ReconPersona[];
  behaviors: ReconBehavior[];
  architecture: ReconArchitectureLine[];
  risks: ReconRisk[];
  gaps: ReconGap[];
}

export interface ReconResult {
  repoUrl: string;
  filesIndexed: number;
  report: ReconReport;
}

export interface ConfigInjectionFile {
  path: string;
  addedLines: number;
}

export interface ConfigInjectionResult {
  pullRequest: { number: number; url: string; branch: string; filesCommitted: string[] };
  files: ConfigInjectionFile[];
  noRunsUntilMerged: boolean;
}

export interface SeededSpec {
  specId: string;
  title: string;
  source: "github_issue" | "agent_gap";
  origin: string;
}

export interface SeedDagResult {
  seeded: SeededSpec[];
  duplicatesDropped: number;
  fromIssues: number;
  fromGaps: number;
}

export interface GovernanceResult {
  projectId: string;
  governancePosture: GovernancePosture;
  externalPushPolicy: string;
}
