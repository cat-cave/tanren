// A purely in-memory VcsProvider for the conformance suite — a TEST FIXTURE
// (lives under tests/, never src/). It implements the contract directly off an
// in-memory model rather than any HTTP transport, proving the suite pins the
// contract itself (not a GitHub-shaped transport). It mirrors the scenario the
// conformance suite primes: a present base-branch file, a mergeable PR #7, and a
// conflicted PR (CONFORMANCE_CONFLICT_PR_NUMBER).
import {
  CONFORMANCE_ABSENT_BRANCH,
  CONFORMANCE_ABSENT_FILE,
  CONFORMANCE_ANCESTOR_CONFLICT,
  CONFORMANCE_BASE_BRANCH,
  CONFORMANCE_BEHIND_PR_NUMBER,
  CONFORMANCE_CONFLICT_PR_NUMBER,
  CONFORMANCE_DIRTY_PR_NUMBER,
  CONFORMANCE_FAILING_BRANCH,
  CONFORMANCE_HEAD_BRANCH,
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
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  OpenDraftPullRequestInput,
  OpenedPullRequest,
  PullRequestMergeability,
  PullRequestRef,
  PushBranchInput,
  RepoRef,
  ResolvedVcsToken,
  UpdateBranchResult,
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
  async readBranchChecks(input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<GitHubPullRequestChecks> {
    // The well-known FAILING integration ref reports a failed check (a bad
    // interaction); every other ref is green.
    if (input.branch === CONFORMANCE_FAILING_BRANCH) {
      return {
        head: { sha: `sha-${input.branch}` },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        statuses: [],
      };
    }
    return {
      head: { sha: `sha-${input.branch}` },
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
  async readBranchHeadSha(input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined> {
    // A deterministic head SHA per branch (the conformance suite asserts the read
    // round-trips); the well-known absent branch returns undefined (missing ref).
    if (input.branch === CONFORMANCE_ABSENT_BRANCH) return undefined;
    return `sha-${input.branch}`;
  }
  async readMergeability(pr: PullRequestRef, _token: ResolvedVcsToken): Promise<PullRequestMergeability> {
    const refs = { baseBranch: CONFORMANCE_BASE_BRANCH, headBranch: CONFORMANCE_HEAD_BRANCH };
    if (pr.number === CONFORMANCE_BEHIND_PR_NUMBER) return { state: "behind", behind: true, ...refs };
    if (pr.number === CONFORMANCE_DIRTY_PR_NUMBER || pr.number === CONFORMANCE_CONFLICT_PR_NUMBER) {
      return { state: "dirty", behind: false, ...refs };
    }
    return { state: "clean", behind: false, ...refs };
  }
  async updateBranch(pr: PullRequestRef, _token: ResolvedVcsToken): Promise<UpdateBranchResult> {
    if (pr.number === CONFORMANCE_BEHIND_PR_NUMBER) return { outcome: "updated", message: "updated onto base" };
    if (pr.number === CONFORMANCE_DIRTY_PR_NUMBER || pr.number === CONFORMANCE_CONFLICT_PR_NUMBER) {
      return { outcome: "conflict", message: "merge conflict" };
    }
    return { outcome: "up_to_date", message: "already up to date" };
  }
  async buildIntegrationBranch(input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    // Merge ancestors in order until one matches the well-known conflict ancestor
    // — that one collides with whatever was integrated before it.
    const merged: string[] = [];
    for (const ancestor of input.ancestors) {
      if (ancestor.specId === CONFORMANCE_ANCESTOR_CONFLICT.specId) {
        const otherSpecId = merged.at(-1) ?? input.baseBranch;
        return {
          outcome: "conflict",
          integrationBranch: input.integrationBranch,
          mergedAncestors: merged,
          ancestorHeadShas: Object.fromEntries(merged.map((id) => [id, `sha-${id}`])),
          conflictBetween: { specId: ancestor.specId, otherSpecId },
          message: `ancestor ${ancestor.specId} conflicts with ${otherSpecId}`,
        };
      }
      merged.push(ancestor.specId);
    }
    return {
      outcome: "integrated",
      integrationBranch: input.integrationBranch,
      mergedAncestors: merged,
      ancestorHeadShas: Object.fromEntries(merged.map((id) => [id, `sha-${id}`])),
      message: `integrated ${merged.length} ancestor(s)`,
    };
  }
  /** Recorded retargets/deletes so the conformance suite can assert them. */
  readonly retargets: Array<{ prNumber: number; newBase: string }> = [];
  readonly deletedBranches: string[] = [];
  async retargetPullRequestBase(pr: PullRequestRef, newBase: string, _token: ResolvedVcsToken): Promise<void> {
    this.retargets.push({ prNumber: pr.number, newBase });
  }
  async deleteBranch(_repo: RepoRef, branch: string, _token: ResolvedVcsToken): Promise<void> {
    this.deletedBranches.push(branch);
  }
}
