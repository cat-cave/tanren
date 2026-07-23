/* eslint-disable vitest/require-mock-type-parameters -- action-spy inference is the staged-capability fixture */
import { describe, expect, it, vi } from "vitest";
import type { FindingIssueGateway } from "../src/findingIssues.js";
import type { MergeAuthorityGateway, MergeAuthorityRecorder } from "../src/mergeAuthority.js";
import { runApprovedPostReview } from "../src/postReview.js";
import type { CommandExecutor } from "../src/process.js";
import type { ReviewOnceResult } from "../src/reviewOnce.js";
import { FailureNotifier } from "../src/service.js";
import { runStagedCandidate } from "../src/stagedRollout.js";
import type { PrState } from "../src/stateSchemas.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";

function state(disposition: PrState["disposition"] = "approved"): PrState {
  return {
    pr: 1240,
    lastSeenHeadSha: firstSha,
    lastReviewedHeadSha: firstSha,
    lastReviewedBaseSha: secondSha,
    auditedIssueNumber: 1249,
    rubricVersion: "2026-07-22",
    reviewId: 55,
    findingIds: [],
    disposition,
    firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
    lastAuthorActivityAt: "2026-07-21T00:00:00.000Z",
    awaitingAuthorSince: null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [],
    reminderDaysSent: [],
    abandonmentReason: null,
    auditStatus: "completed",
    lastCompletedMode: "review",
    reviewFindings: [],
  };
}

function review(
  verdict: ReviewOnceResult["verdict"],
  disposition: PrState["disposition"] = "approved",
  blocked = false,
): ReviewOnceResult {
  return {
    blocked,
    verdict,
    posted: !blocked,
    reviewId: blocked ? null : 55,
    state: state(disposition),
    reason: blocked ? "fail-closed prerequisite missing" : null,
    findings: [],
  };
}

describe("staged rollout enforcement", () => {
  it("SHADOW produces only a local draft and exposes no GitHub write action", async () => {
    const localDraft = vi.fn(async () => review("APPROVE"));
    const githubWrite = vi.fn();
    const result = await runStagedCandidate({ mode: "shadow", auditToLocalDraft: localDraft });
    expect(result).toMatchObject({ mergeAttempted: false, merged: false, routed: [] });
    expect(localDraft).toHaveBeenCalledOnce();
    expect(githubWrite).not.toHaveBeenCalled();
  });

  it("REVIEW posts and routes but has no reachable merge callback", async () => {
    const route = vi.fn(async () => [1300]);
    const merge = vi.fn();
    const result = await runStagedCandidate({
      mode: "review",
      auditAndPostReview: async () => review("APPROVE"),
      routeIssues: route,
      superviseAbandonment: vi.fn(),
    });
    expect(result).toMatchObject({ mergeAttempted: false, merged: false, routed: [1300] });
    expect(route).toHaveBeenCalledOnce();
    expect(merge).not.toHaveBeenCalled();
  });

  it("MERGE reaches authorization only after a complete approved review", async () => {
    const mergeIfClear = vi.fn(async () => true);
    for (const failed of [review(null, "error", true), review("REQUEST_CHANGES", "changes_requested")]) {
      await runStagedCandidate({
        mode: "merge",
        auditAndPostReview: async () => failed,
        mergeIfClear,
        superviseAbandonment: vi.fn(),
      });
    }
    expect(mergeIfClear).not.toHaveBeenCalled();
    const result = await runStagedCandidate({
      mode: "merge",
      auditAndPostReview: async () => review("APPROVE"),
      mergeIfClear,
      superviseAbandonment: vi.fn(),
    });
    expect(result).toMatchObject({ mergeAttempted: true, merged: true });
    expect(mergeIfClear).toHaveBeenCalledOnce();
  });
});

describe("restart and failure operations", () => {
  it("restarts after a verified merge by routing recovery only, never calling merge again", async () => {
    const mergeGateway: MergeAuthorityGateway = {
      readFresh: vi.fn(async () => {
        throw new Error("merge path must be unreachable");
      }),
      squashMerge: vi.fn(async () => {
        throw new Error("merge path must be unreachable");
      }),
      readMerged: vi.fn(async () => {
        throw new Error("merge path must be unreachable");
      }),
      readIssueClosureReconciliation: vi.fn(async () => {
        throw new Error("merge path must be unreachable");
      }),
      reopenWronglyClosedIssue: vi.fn(async () => {}),
      ensureAuditedIssueClosed: vi.fn(async () => {}),
    };
    const issueGateway: FindingIssueGateway = {
      findByMarker: vi.fn(async () => null),
      create: vi.fn(async () => 1300),
      listBlockedBy: vi.fn(async () => []),
      issueDatabaseId: vi.fn(async () => 1),
      addBlockedBy: vi.fn(async () => {}),
    };
    const recorder: MergeAuthorityRecorder = {
      record: vi.fn(async () => {}),
      recordSecurityAnomaly: vi.fn(async () => {}),
    };
    const writes: PrState[] = [];
    const result = await runApprovedPostReview(
      {
        mergeGateway,
        issueGateway,
        recorder,
        stateStore: { write: async (value: PrState) => void writes.push(value) },
      },
      {
        state: state("merged"),
        authorization: {
          pr: 1240,
          auditedHeadSha: firstSha,
          auditedBaseSha: secondSha,
          auditedIssueNumber: 1249,
          rubricVersion: "2026-07-22",
          casHeadSha: firstSha,
        },
        issueContext: {
          repository: "cat-cave/tanren",
          pr: 1240,
          headSha: firstSha,
          reviewId: 55,
          bucketLabel: "cra",
          blockedBy: [],
        },
        findings: [],
      },
    );
    expect(result.merge.reasons).toEqual(["recovered post-merge routing"]);
    expect(mergeGateway.readFresh).not.toHaveBeenCalled();
    expect(mergeGateway.squashMerge).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it("sends failures to the configured loud notifier and fails if notification is unavailable", async () => {
    const executor = vi.fn<CommandExecutor>(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    await new FailureNotifier(testConfig(), executor).notify(new Error("audit worker unreachable"));
    expect(executor.mock.calls[0]?.[0].args.at(-1)).toContain("CRA FAILURE");
    const failed = vi.fn<CommandExecutor>(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "logger unavailable",
    }));
    await expect(new FailureNotifier(testConfig(), failed).notify(new Error("boom"))).rejects.toThrow(
      "failure notifier exited",
    );
  });
});
