import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditArtifactStore } from "../src/artifactStore.js";
import { GithubMergeGateway } from "../src/githubMerge.js";
import { resolveCraPaths } from "../src/paths.js";
import type { CommandExecutor } from "../src/process.js";
import { SingletonLease } from "../src/singleton.js";
import { PrStateStore } from "../src/stateStore.js";
import { buildReviewMarker } from "../src/reviewMarker.js";
import { validReport } from "./auditFixtures.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("GitHub merge snapshot", () => {
  it("controls the squash message and idempotently reopens a wrongly-closed issue", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "cra-github-reconcile-"));
    roots.push(root);
    const paths = resolveCraPaths("cat-cave/tanren", {
      HOME: root,
      XDG_STATE_HOME: resolve(root, "state"),
    });
    const lease = await SingletonLease.acquire(paths.lockFile);
    const requests: { route: string; input?: string }[] = [];
    let issueReads = 0;
    const executor = vi.fn<CommandExecutor>(async (request) => {
      const route = request.args.join(" ");
      requests.push({ route, input: request.input });
      if (route.includes("/pulls/1240/merge")) {
        return { stdout: JSON.stringify({ merged: true, sha: firstSha }), stderr: "", exitCode: 0 };
      }
      if (route.includes("/issues/999/comments") && route.includes("--paginate")) {
        return { stdout: JSON.stringify([[]]), stderr: "", exitCode: 0 };
      }
      if (route.includes("/issues/999/comments")) {
        return { stdout: JSON.stringify({ id: 1 }), stderr: "", exitCode: 0 };
      }
      if (route.includes("/issues/999") && !route.includes("--method PATCH")) {
        issueReads += 1;
        return {
          stdout: JSON.stringify({ number: 999, state: issueReads === 1 ? "closed" : "open" }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (route.includes("/issues/999") && route.includes("--method PATCH")) {
        return { stdout: JSON.stringify({ number: 999, state: "open" }), stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected request: ${route}`);
    });
    const gateway = new GithubMergeGateway(
      testConfig(),
      "token",
      new AuditArtifactStore(paths, lease),
      new PrStateStore(paths, lease),
      lease,
      executor,
    );

    await gateway.squashMerge(1240, firstSha, "controlled title", "controlled message");
    await gateway.reopenWronglyClosedIssue(1240, 999);
    await gateway.reopenWronglyClosedIssue(1240, 999);

    const mergeRequest = requests.find((request) => request.route.includes("/pulls/1240/merge"));
    expect(JSON.parse(mergeRequest?.input ?? "")).toEqual({
      merge_method: "squash",
      sha: firstSha,
      commit_title: "controlled title",
      commit_message: "controlled message",
    });
    expect(requests.filter((request) => request.route.includes("/issues/999/comments --input"))).toHaveLength(1);
    expect(
      requests.filter((request) => request.route.includes("/issues/999") && request.route.includes("--method PATCH")),
    ).toHaveLength(1);
    await lease.release();
  });

  it("requests inherited rulesets and proves whether the disposition review is genuinely latest", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "cra-github-merge-"));
    roots.push(root);
    const paths = resolveCraPaths("cat-cave/tanren", {
      HOME: root,
      XDG_STATE_HOME: resolve(root, "state"),
    });
    const lease = await SingletonLease.acquire(paths.lockFile);
    const states = new PrStateStore(paths, lease);
    await states.recover();
    await states.write({
      pr: 1240,
      lastSeenHeadSha: firstSha,
      lastReviewedHeadSha: firstSha,
      lastReviewedBaseSha: secondSha,
      auditedIssueNumber: 100,
      rubricVersion: "2026-07-22",
      reviewId: 55,
      findingIds: [],
      disposition: "approved",
      firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
      lastAuthorActivityAt: "2026-07-21T00:00:00.000Z",
      awaitingAuthorSince: null,
      retry: { attempts: 0, nextAttemptAt: null, lastError: null },
      followUpIssues: [],
      reminderDaysSent: [],
      abandonmentReason: null,
      auditStatus: "completed",
    });
    const artifacts = new AuditArtifactStore(paths, lease);
    await artifacts.writeReport({
      pr: 1240,
      headSha: firstSha,
      baseSha: secondSha,
      auditedIssueNumber: 100,
      rubricVersion: "2026-07-22",
      createdAt: "2026-07-22T12:00:00.000Z",
      report: validReport(),
    });

    const executor = vi.fn<CommandExecutor>(async (request) => {
      const route = request.args.join(" ");
      if (route.includes(" graphql ")) {
        return {
          stdout: JSON.stringify({
            data: {
              viewer: { login: "trevor-workstation[bot]" },
              repository: {
                viewerPermission: "ADMIN",
                pullRequest: {
                  number: 1240,
                  state: "OPEN",
                  isDraft: false,
                  title: "Bound review",
                  body: "Closes #100",
                  updatedAt: "2026-07-22T12:00:00.000Z",
                  baseRefName: "main",
                  baseRefOid: secondSha,
                  headRefOid: firstSha,
                  mergeStateStatus: "CLEAN",
                  mergeable: "MERGEABLE",
                  commits: { totalCount: 1, pageInfo: { hasNextPage: false } },
                  closingIssuesReferences: {
                    nodes: [
                      {
                        number: 100,
                        state: "CLOSED",
                        timelineItems: {
                          nodes: [{ closer: { __typename: "PullRequest", number: 1240 } }],
                          pageInfo: { hasNextPage: false },
                        },
                        blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                  reviews: {
                    nodes: [
                      {
                        databaseId: 55,
                        author: { login: "trevor-workstation[bot]" },
                        state: "APPROVED",
                        submittedAt: "2026-07-22T12:00:00.000Z",
                        body: buildReviewMarker({
                          pr: 1240,
                          headSha: firstSha,
                          rubricVersion: "2026-07-22",
                        }),
                        commit: { oid: firstSha },
                      },
                      {
                        databaseId: 56,
                        author: { login: "trevor-workstation[bot]" },
                        state: "CHANGES_REQUESTED",
                        submittedAt: "2026-07-22T13:00:00.000Z",
                        body: buildReviewMarker({
                          pr: 1240,
                          headSha: firstSha,
                          rubricVersion: "2026-07-21",
                        }),
                        commit: { oid: firstSha },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
              rateLimit: { remaining: 5_000, cost: 1 },
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (route.includes("/rulesets/77")) {
        return {
          stdout: JSON.stringify({
            enforcement: "active",
            rules: [
              {
                type: "required_status_checks",
                parameters: { required_status_checks: [{ context: "org/security" }] },
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (route.includes("/rulesets")) {
        return { stdout: JSON.stringify([{ id: 77 }]), stderr: "", exitCode: 0 };
      }
      if (route.includes("required_status_checks")) {
        return { stdout: JSON.stringify({ contexts: ["ci"], checks: [] }), stderr: "", exitCode: 0 };
      }
      if (route.includes("/check-runs")) {
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "org/security", status: "IN_PROGRESS", conclusion: null },
            ],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (route.includes("/status")) {
        return { stdout: JSON.stringify({ statuses: [] }), stderr: "", exitCode: 0 };
      }
      if (route.includes("/issues/100")) {
        return { stdout: JSON.stringify({ number: 100, state: "closed" }), stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected request: ${route}`);
    });

    const gateway = new GithubMergeGateway(testConfig(), "token", artifacts, states, lease, executor);
    const snapshot = await gateway.readFresh({
      pr: 1240,
      auditedHeadSha: firstSha,
      auditedBaseSha: secondSha,
      auditedIssueNumber: 100,
      casHeadSha: firstSha,
      rubricVersion: "2026-07-22",
    });
    expect(snapshot.requiredContexts).toEqual(["ci", "org/security"]);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({ name: "org/security", status: "IN_PROGRESS" }));
    expect(snapshot.latestCraReview).toMatchObject({ id: 55, state: "APPROVED", latest: false });
    await expect(gateway.readIssueClosureReconciliation(1240, 100, firstSha)).resolves.toEqual({
      closedByPullRequest: [100],
      auditedIssueState: "CLOSED",
    });
    const rulesetRequest = executor.mock.calls
      .map(([request]) => request)
      .find((request) => request.args.includes("/repos/cat-cave/tanren/rulesets"));
    expect(rulesetRequest?.args).toContain("includes_parents=true");
    await lease.release();
  });
});
