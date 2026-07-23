import type { IsolatedControlRunner } from "../src/auditAdapter.js";
import { buildAuditContext, type AuditContext, type AuditContextInput } from "../src/auditContext.js";
import type { AuditReport } from "../src/auditReport.js";
import type { DiscoveredCheck, DiscoveredPullRequest } from "../src/discovery.js";
import type { CommandResult } from "../src/process.js";
import type { GroundTruthInput } from "../src/reviewOnce.js";
import type { VerifiedWorktree } from "../src/worktree.js";
import { firstSha, secondSha } from "./helpers.js";

// A cited file the supervisor can locate in the tree, so a clean acceptance trace
// resolves. `just looks good`-style prose does NOT resolve.
export const knownFiles = ["ops/cra/src/auditAdapter.ts", "ops/cra/tests/audit.test.ts"];

export function discoveredPullRequest(overrides: Partial<DiscoveredPullRequest> = {}): DiscoveredPullRequest {
  return {
    number: 1240,
    title: "node(cra-05): deep adversarial audit adapter",
    body: "Closes #1244",
    isDraft: false,
    author: "contributor",
    baseBranch: "main",
    baseSha: secondSha,
    headSha: firstSha,
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    closingIssues: [{ number: 1244, state: "OPEN", blockers: [], dependenciesReady: true }],
    checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", kind: "check_run" }],
    reviews: [],
    firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
    lastAuthorActivityAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

export function auditContextInput(overrides: Partial<AuditContextInput> = {}): AuditContextInput {
  return {
    pullRequest: discoveredPullRequest(),
    issue: {
      number: 1244,
      title: "cra-05: deep adversarial audit adapter",
      body: "Spawn a cross-model audit worker.",
      acceptance: "A well-formed PR yields a valid strict report.",
      requiredNegativeControl: "A report missing executed negative controls is rejected.",
      blockers: [],
    },
    diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n+added\n",
    deletionStats: [],
    checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", kind: "check_run" }],
    standards: "Repository standards.",
    authorIsAgent: true,
    authorModelFamily: "codex",
    ...overrides,
  };
}

export function auditContext(overrides: Partial<AuditContextInput> = {}): AuditContext {
  return buildAuditContext(auditContextInput(overrides));
}

export function verifiedWorktree(): VerifiedWorktree {
  return { path: "/tmp/cra-worktrees/pr-1240-111111111111", ref: "refs/cra/pr-1240-111111111111", headSha: firstSha };
}

const passingCheck: DiscoveredCheck = { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", kind: "check_run" };

// Supervisor-computed ground truth for a clean PR: a no-deletion diff, a passing
// required check, and a tree containing the cited acceptance file.
export function cleanGroundTruth(overrides: Partial<GroundTruthInput> = {}): GroundTruthInput {
  return {
    diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n+added\n",
    requiredChecks: [passingCheck],
    knownFiles: [...knownFiles],
    ...overrides,
  };
}

// A well-formed advisory report: acceptance satisfied and CITING a locatable file, no
// findings, one mandatory executed control the worker reports as rejecting.
export function validReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    rubricVersion: "2026-07-22",
    headSha: firstSha,
    baseSha: secondSha,
    examinedFiles: ["ops/cra/src/auditAdapter.ts"],
    acceptanceTraces: [
      {
        statement: "A well-formed PR yields a valid strict report.",
        satisfied: true,
        evidence: "covered by ops/cra/tests/audit.test.ts",
      },
    ],
    deletionAccounting: [],
    negativeControls: [
      {
        id: "malformed-report",
        description: "A malformed report must be rejected.",
        mandatory: true,
        kind: "executed",
        command: { executable: "node", args: ["reject-malformed.mjs"] },
        expectedRejection: "non-zero exit",
        observedResult: "exit 1",
        rejected: true,
        evidenceRef: "worker.log",
      },
    ],
    unresolvedChecks: [],
    findings: [],
    ...overrides,
  };
}

// The trusted verification passed (exit 0) — the only sandbox execution.
export const passingRunner: IsolatedControlRunner = {
  run: async (): Promise<CommandResult> => ({ stdout: "ok", stderr: "", exitCode: 0 }),
};

// The trusted verification failed (exit 1).
export const failingRunner: IsolatedControlRunner = {
  run: async (): Promise<CommandResult> => ({ stdout: "", stderr: "verification failed", exitCode: 1 }),
};
