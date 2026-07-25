/**
 * brownfield full-track client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/brownfield` recon/seed contracts + the
 * config-injection / governance route payloads. Kept in their own module (the
 * discovery/greenfield isolation lesson: parallel client-touching screens own
 * their own api modules so they never diverge a shared client).
 */

import { z } from "zod";

// Mirrors the orchestrator's `GovernancePosture` z.enum in
// `services/orchestrator/src/engine/config/shared.ts` — extend both together.
export type GovernancePosture = "strict" | "open" | "audit_only" | "lenient";

const ReconPersonaSchema = z.object({ name: z.string(), description: z.string(), inferredFrom: z.string() }).strict();
const ReconBehaviorSchema = z.object({ persona: z.string(), title: z.string(), inferredFrom: z.string() }).strict();
const ReconArchitectureLineSchema = z.object({ layer: z.string(), detail: z.string() }).strict();
const ReconRiskSchema = z.object({ severity: z.enum(["info", "warn", "fail"]), note: z.string() }).strict();
const ReconGapSchema = z
  .object({
    id: z.string(),
    chapter: z.string(),
    question: z.string(),
    options: z.array(z.string()),
  })
  .strict();

export const ReconReportSchema = z
  .object({
    identity: z.object({ slug: z.string(), purpose: z.string(), inferredFrom: z.string() }).strict(),
    personas: z.array(ReconPersonaSchema),
    behaviors: z.array(ReconBehaviorSchema),
    architecture: z.array(ReconArchitectureLineSchema),
    risks: z.array(ReconRiskSchema),
    gaps: z.array(ReconGapSchema),
  })
  .strict();
export type ReconReport = z.infer<typeof ReconReportSchema>;

export interface ReconResult {
  repoUrl: string;
  filesIndexed: number;
  report: ReconReport;
  state: string;
}

/** Decode only for rendering; the orchestrator verifies the HMAC before use. */
export function decodeReconStateForDisplay(raw: string): { repoUrl: string; report: ReconReport } | undefined {
  const encoded = raw.split(".")[0];
  if (encoded === undefined || encoded === "") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const state = z
      .object({ kind: z.literal("recon"), repoUrl: z.string(), report: ReconReportSchema })
      .passthrough()
      .safeParse(parsed);
    return state.success ? { repoUrl: state.data.repoUrl, report: state.data.report } : undefined;
  } catch {
    return undefined;
  }
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
