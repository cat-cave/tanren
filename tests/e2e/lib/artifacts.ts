// P8b — real persisted-artifact readers + assertions (autonomy-engine §8b).
//
// The e2e gate's whole value is that it asserts on REAL artifacts, never on a
// mocked return. This module is the assertion core: given the rows a live run
// persisted (read straight from Postgres) and the GitHub PR state (read from the
// real REST API), it decides whether the case's declared artifacts are real.
//
// These functions are PURE over their inputs (the rows / the PR view), so the
// harness unit test can exercise the exact same pass/fail logic the credentialed
// run uses — the gate's verdict is the same code in CI and in the nightly run.

import type { PersistedArtifactKind } from "./manifest.js";

// The persisted run snapshot the harness reads from Postgres after a run. Mirrors
// the acceptance gate's observation surface (scripts/acceptance/common.ts) but is
// declared here independently so the e2e gate never imports an internal seam.
export interface RunArtifacts {
  readonly runId: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly prUrl: string | null;
  // One row per cost_records entry: the role and how the dollar figure was
  // derived. A real run records real spend; 'unknown' basis is allowed (cost is
  // best-effort) but the row + a real billing_mode must exist.
  readonly costRecords: readonly { readonly taskKind: string; readonly basis: string; readonly billingMode: string }[];
  // The DORA projection rows the merged run accumulated into (deployment freq /
  // lead time etc.). Non-empty means the merge accumulated into DORA.
  readonly doraDeploymentCount: number;
}

// The real GitHub PR view (read from the REST API). `mergeCommitSha` is set once
// the PR is actually merged onto the base branch.
export interface GithubPrView {
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly baseBranch: string;
}

// Whether the implemented file is present on the base branch after the merge
// (read from the GitHub contents API at the merge SHA).
export interface ImplementedFileView {
  readonly path: string;
  readonly presentOnBase: boolean;
}

export interface ArtifactEvidence {
  readonly run: RunArtifacts;
  readonly pr?: GithubPrView;
  readonly file?: ImplementedFileView;
}

// assertArtifact returns null if the given real artifact is genuinely present, or
// a problem string if it is missing/fake. The harness calls this per declared
// artifact; a non-null result fails the case.
export function assertArtifact(kind: PersistedArtifactKind, evidence: ArtifactEvidence): string | null {
  switch (kind) {
    case "merged_pr":
      return assertMergedPr(evidence);
    case "implemented_file":
      return assertImplementedFile(evidence);
    case "cost_records":
      return assertCostRecords(evidence.run);
    case "dora_projection":
      return assertDora(evidence.run);
    case "dag_spec":
    case "ingested_issue":
      // These land with their autonomy-engine capability (planned cases). The
      // harness skips planned cases, so this is only reached if a capability
      // case is flipped active before its reader is wired — fail loudly.
      return `artifact kind "${kind}" has no reader yet; wire it when its capability lands`;
    default:
      return assertExhaustive(kind);
  }
}

function assertMergedPr(evidence: ArtifactEvidence): string | null {
  if (evidence.run.prUrl === null || !/^https:\/\/github\.com\/.+\/pull\/\d+$/u.test(evidence.run.prUrl)) {
    return `expected a persisted GitHub PR URL, got ${String(evidence.run.prUrl)}`;
  }
  if (evidence.pr === undefined) {
    return "no GitHub PR state was read for the merged_pr assertion";
  }
  if (!evidence.pr.merged || evidence.pr.mergeCommitSha === null || evidence.pr.mergeCommitSha === "") {
    return "the PR is not actually merged on GitHub (no merge commit on the base branch)";
  }
  return null;
}

function assertImplementedFile(evidence: ArtifactEvidence): string | null {
  if (evidence.file === undefined) {
    return "no implemented-file state was read for the implemented_file assertion";
  }
  if (!evidence.file.presentOnBase) {
    return `the implemented file "${evidence.file.path}" is not present on the base branch after merge`;
  }
  return null;
}

function assertCostRecords(run: RunArtifacts): string | null {
  if (run.costRecords.length === 0) {
    return "no cost_records rows were persisted for the run";
  }
  const missingBillingMode = run.costRecords.filter((row) => row.billingMode === "");
  if (missingBillingMode.length > 0) {
    return `cost_records missing billing_mode: ${missingBillingMode.length}`;
  }
  return null;
}

function assertDora(run: RunArtifacts): string | null {
  if (run.doraDeploymentCount <= 0) {
    return "the merged run did not accumulate into the DORA projection (deployment count is 0)";
  }
  return null;
}

function assertExhaustive(value: never): string {
  return `unhandled artifact kind: ${String(value)}`;
}
