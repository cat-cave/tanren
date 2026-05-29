// P3-0016: the DAG-seed step. Turns the recon report's GAPS + the repo's open
// GitHub ISSUES into seed specs, created through the SAME P2A-0013 `createSpec`
// path as every other spec (so authz + dependency checks are unchanged). The
// hi-fi shows a source legend (issue vs. gap) + dedupe — we carry each spec's
// `source` so the surface renders the legend, and we de-dupe by a normalized
// title so an issue and a gap describing the same work don't both seed.
//
// Issues are fetched through the existing P3-0022 `IngestedItem` shape (the
// inbox GitHub connector returns these); the engine accepts them as an injected
// list so it stays provider-free + trivially testable. No migration — specs
// land in the existing `specs` table.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { IngestedItem } from "../inbox/types.js";
import { createSpec } from "../../workflow/projectSpec.js";
import type { ReconGap, ReconReport } from "./types.js";

export type SeedSource = "github_issue" | "agent_gap";

export interface SeededSpec {
  specId: string;
  title: string;
  source: SeedSource;
  /** The external id (issue ref) or gap id this spec came from. */
  origin: string;
}

export interface SeedDagInput {
  projectId: string;
  orgId: string;
  report: ReconReport;
  /** Open issues for the repo (P3-0022 `IngestedItem`s). May be empty. */
  issues: ReadonlyArray<IngestedItem>;
  actor: ActorContext;
}

export interface SeedDagResult {
  seeded: SeededSpec[];
  /** Count of items dropped as duplicates (issue ↔ gap title overlap). */
  duplicatesDropped: number;
  fromIssues: number;
  fromGaps: number;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function gapSpecTitle(gap: ReconGap): string {
  // The gap question is the work to settle; keep it concise for the spec title.
  return gap.question.length > 120 ? `${gap.question.slice(0, 117)}...` : gap.question;
}

/**
 * Seed the DAG from recon gaps + GitHub issues. Issues seed first (they carry an
 * operator-authored title), then gaps that don't duplicate an issue title. Each
 * created spec carries its provenance so the surface can render the source
 * legend. NOTHING is force-routed — these are plain pending specs.
 */
export async function seedDagFromReconAndIssues(pool: pg.Pool, input: SeedDagInput): Promise<SeedDagResult> {
  const seeded: SeededSpec[] = [];
  const seenTitles = new Set<string>();
  let duplicatesDropped = 0;
  let fromIssues = 0;
  let fromGaps = 0;

  for (const issue of input.issues) {
    const key = normalizeTitle(issue.title);
    if (key === "" || seenTitles.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seenTitles.add(key);
    const spec = await createSpec(
      pool,
      {
        projectId: input.projectId,
        title: issue.title,
        description: issue.body !== "" ? issue.body : `Seeded from GitHub issue ${issue.externalId}.`,
        acceptanceCriteria: [`given ${issue.externalId}, when addressed, then the issue is resolved`],
      },
      input.actor,
    );
    seeded.push({
      specId: spec.specId,
      title: issue.title,
      source: "github_issue",
      origin: issue.externalId,
    });
    fromIssues += 1;
  }

  for (const gap of input.report.gaps) {
    const title = gapSpecTitle(gap);
    const key = normalizeTitle(title);
    if (key === "" || seenTitles.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seenTitles.add(key);
    const spec = await createSpec(
      pool,
      {
        projectId: input.projectId,
        title,
        description: `Recon gap (${gap.chapter}): ${gap.question}`,
        acceptanceCriteria: [`given the recon gap "${gap.id}", when resolved, then the chapter is complete`],
      },
      input.actor,
    );
    seeded.push({ specId: spec.specId, title, source: "agent_gap", origin: gap.id });
    fromGaps += 1;
  }

  return { seeded, duplicatesDropped, fromIssues, fromGaps };
}
