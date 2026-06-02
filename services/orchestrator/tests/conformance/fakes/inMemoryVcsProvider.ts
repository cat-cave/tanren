// A purely in-memory VcsProvider for the conformance suite — a TEST FIXTURE
// (lives under tests/, never src/). It implements the contract directly off an
// in-memory model rather than any HTTP transport, proving the suite pins the
// contract itself (not a GitHub-shaped transport). It mirrors the scenario the
// conformance suite primes: a present base-branch file, a mergeable PR #7, and a
// conflicted PR (CONFORMANCE_CONFLICT_PR_NUMBER).
import {
  CONFORMANCE_ABSENT_FILE,
  CONFORMANCE_CONFLICT_PR_NUMBER,
  CONFORMANCE_PRESENT_FILE,
  CONFORMANCE_PRESENT_FILE_BODY,
} from "../vcsProviderConformance.js";
import type {
  MergePullRequestResult,
  ReviewVerdictResult,
  SubmitReviewEvent,
} from "../../../src/engine/providers/githubReviewMerge.js";
import type { GitHubPullRequestChecks } from "../../../src/engine/providers/github.js";
import type { PullRequestContributors } from "../../../src/engine/workflow/reviewMerge/governancePosture.js";
import type {
  OpenDraftPullRequestInput,
  OpenedPullRequest,
  PullRequestRef,
  PushBranchInput,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../../../src/engine/contracts/vcsProvider.js";

function parseRepo(url: string): RepoRef {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url);
  if (m === null) throw new Error(`unsupported repository URL: ${url}`);
  return { owner: m[1] ?? "", name: m[2] ?? "" };
}

function parsePr(url: string): PullRequestRef {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url);
  if (m === null) throw new Error(`unsupported pull request URL: ${url}`);
  return { repo: { owner: m[1] ?? "", name: m[2] ?? "" }, number: Number(m[3]) };
}

/** In-memory contract impl. Records nothing the suite asserts beyond the contract surface. */
export class InMemoryVcsProvider implements VcsProvider {
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "in-memory-token", source: "static", refresh: async () => "in-memory-token-refreshed" };
  }
  parseRepository(repoUrl: string): RepoRef {
    return parseRepo(repoUrl);
  }
  parsePullRequest(prUrl: string): PullRequestRef {
    return parsePr(prUrl);
  }
  async pushBranch(_input: PushBranchInput): Promise<void> {}
  async openDraftPullRequest(input: OpenDraftPullRequestInput): Promise<OpenedPullRequest> {
    return {
      number: 7,
      url: `https://github.com/${input.repo.owner}/${input.repo.name}/pull/7`,
      reused: false,
    };
  }
  async markReadyForReview(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<void> {}
  async readPullRequestChecks(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<GitHubPullRequestChecks> {
    return {
      head: { sha: "deadbeef" },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [],
    };
  }
  async readReviewVerdict(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<ReviewVerdictResult> {
    return { verdict: "approved", latest: { state: "approved", reviewer: "bot" } };
  }
  async readPullRequestDiff(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<string> {
    return "diff --git a/file b/file";
  }
  async submitReview(
    _pr: PullRequestRef,
    _event: SubmitReviewEvent,
    _body: string,
    _token: ResolvedVcsToken,
  ): Promise<void> {}
  async listContributors(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<PullRequestContributors> {
    return { logins: ["author-bot"] };
  }
  async applyQueueLabel(_pr: PullRequestRef, _label: string, _token: ResolvedVcsToken): Promise<void> {}
  async mergePullRequest(pr: PullRequestRef, _token: ResolvedVcsToken): Promise<MergePullRequestResult> {
    if (pr.number === CONFORMANCE_CONFLICT_PR_NUMBER) {
      return { merged: false, conflict: true, status: 409, message: "merge conflict" };
    }
    return { merged: true, mergeSha: "merge-sha", conflict: false, status: 200, message: "merged" };
  }
  async readFileOnBranch(input: {
    repo: RepoRef;
    ref: string;
    path: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined> {
    if (input.path === CONFORMANCE_PRESENT_FILE) return CONFORMANCE_PRESENT_FILE_BODY;
    if (input.path === CONFORMANCE_ABSENT_FILE) return undefined;
    return undefined;
  }
}
