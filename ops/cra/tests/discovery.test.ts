import { describe, expect, it, vi } from "vitest";
import { GithubDiscovery, isSubstantiveAuthorReply, selectReviewCandidates } from "../src/discovery.js";
import type { CommandExecutor } from "../src/process.js";
import type { PrState } from "../src/stateSchemas.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";

function pullRequest(number: number, headSha: string, draft = false) {
  return {
    number,
    title: `PR ${number}`,
    body: `Closes #${number + 100}`,
    state: "OPEN",
    isDraft: draft,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    author: { login: "contributor" },
    baseRefName: "main",
    baseRefOid: secondSha,
    headRefOid: headSha,
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    closingIssuesReferences: {
      nodes: [
        {
          number: number + 100,
          state: "OPEN",
          blockedBy: {
            nodes: [
              { number: 10, state: "CLOSED" },
              { number: 11, state: number === 1 ? "CLOSED" : "OPEN" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    comments: {
      nodes: [
        { author: { login: "reviewer" }, createdAt: "2026-07-21T01:00:00.000Z" },
        { author: { login: "contributor" }, createdAt: "2026-07-21T02:00:00.000Z" },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    commits: {
      nodes: [{ commit: { committedDate: "2026-07-22T03:00:00.000Z", author: { user: { login: "contributor" } } } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    reviews: {
      nodes: [
        {
          id: "PRR_node",
          databaseId: 55,
          author: { login: "trevor-workstation[bot]" },
          state: "APPROVED",
          submittedAt: "2026-07-22T04:00:00.000Z",
          body: "<!-- tanren-cra:v1 -->",
          commit: { oid: headSha },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    statusCheckRollup: {
      contexts: {
        nodes: [
          { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "StatusContext", context: "external", state: "SUCCESS" },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function reviewedState(pr: number, headSha: string): PrState {
  return {
    pr,
    lastSeenHeadSha: headSha,
    lastReviewedHeadSha: headSha,
    lastReviewedBaseSha: secondSha,
    rubricVersion: "2026-07-22",
    reviewId: 55,
    findingIds: [],
    disposition: "approved",
    firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
    lastAuthorActivityAt: "2026-07-22T03:00:00.000Z",
    awaitingAuthorSince: null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [],
    auditStatus: "completed",
  };
}

describe("read-only GitHub discovery", () => {
  it("classifies only ETA or structured finding replies as substantive activity", () => {
    expect(isSubstantiveAuthorReply("ETA tomorrow; I will address P1 first.")).toBe(true);
    expect(isSubstantiveAuthorReply("- [x] Finding auth-race fixed")).toBe(true);
    expect(isSubstantiveAuthorReply("Thanks!")).toBe(false);
    expect(isSubstantiveAuthorReply("rebased")).toBe(false);
  });

  it("normalizes all review inputs and performs only gh api graphql reads", async () => {
    const response = {
      data: {
        repository: {
          pullRequests: {
            nodes: [pullRequest(1, firstSha), pullRequest(2, secondSha)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const executor = vi
      .fn<CommandExecutor>()
      .mockResolvedValue({ stdout: JSON.stringify(response), stderr: "", exitCode: 0 });
    const discovered = await new GithubDiscovery(
      testConfig(),
      "installation-token-value",
      executor,
    ).listOpenPullRequests();
    expect(discovered).toHaveLength(2);
    expect(discovered[0]).toMatchObject({
      number: 1,
      headSha: firstSha,
      baseSha: secondSha,
      mergeStateStatus: "CLEAN",
      firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
      lastAuthorActivityAt: "2026-07-22T03:00:00.000Z",
    });
    expect(discovered[0]?.closingIssues[0]).toMatchObject({ dependenciesReady: true });
    expect(discovered[1]?.closingIssues[0]).toMatchObject({ dependenciesReady: false });
    expect(discovered[0]?.checks).toEqual([
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", kind: "check_run" },
      { name: "external", status: "SUCCESS", conclusion: "SUCCESS", kind: "status_context" },
    ]);
    const request = executor.mock.calls[0]?.[0];
    expect(request?.args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(request?.args).not.toContain("--method");
    const query = request?.args.find((arg) => arg.startsWith("query="));
    expect(query).toMatch(/^query=query CraDiscovery/u);
    expect(query).not.toContain("mutation");
  });

  it("selects only new, changed, interrupted, or rubric-invalidated non-draft heads", async () => {
    const response = {
      data: {
        repository: {
          pullRequests: {
            nodes: [pullRequest(1, firstSha), pullRequest(2, secondSha), pullRequest(3, firstSha, true)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const executor: CommandExecutor = async () => ({ stdout: JSON.stringify(response), stderr: "", exitCode: 0 });
    const pullRequests = await new GithubDiscovery(
      testConfig(),
      "installation-token-value",
      executor,
    ).listOpenPullRequests();
    const states = new Map<number, PrState>([
      [1, reviewedState(1, firstSha)],
      [2, reviewedState(2, firstSha)],
    ]);
    expect(selectReviewCandidates(pullRequests, states, "2026-07-22").map((pr) => pr.number)).toEqual([2]);
    states.set(2, { ...reviewedState(2, secondSha), rubricVersion: "old-rubric" });
    expect(selectReviewCandidates(pullRequests, states, "2026-07-22").map((pr) => pr.number)).toEqual([2]);
    states.set(2, { ...reviewedState(2, secondSha), auditStatus: "in_progress" });
    expect(selectReviewCandidates(pullRequests, states, "2026-07-22").map((pr) => pr.number)).toEqual([2]);
  });

  it("fails closed when a nested connection is truncated", async () => {
    const pr = pullRequest(1, firstSha);
    pr.comments.pageInfo.hasNextPage = true;
    const response = {
      data: { repository: { pullRequests: { nodes: [pr], pageInfo: { hasNextPage: false, endCursor: null } } } },
    };
    const executor: CommandExecutor = async () => ({ stdout: JSON.stringify(response), stderr: "", exitCode: 0 });
    await expect(
      new GithubDiscovery(testConfig(), "installation-token-value", executor).listOpenPullRequests(),
    ).rejects.toThrow("fail-closed page limit");
  });
});
