// P2·0: the GitHub VcsProvider impl. It COMPOSES the existing GitHub code —
// `GitHubPullRequestService` (draft-PR), `GitHubStatusService` (CI/checks),
// `GitHubReviewMergeService` (mark-ready / reviews / diff / label / merge), the
// `resolveGithubToken` resolver (App-first + 401-refresh), and the
// `pushWorkspaceBranchToGitHub` SSH push — behind the provider-neutral
// `VcsProvider` seam. It DOES NOT re-implement any GitHub logic; it wraps it, so
// behavior is preserved exactly (token-via-stdin clone auth, the GraphQL ready
// mutation, the timed HTTP wrapper that decorates `githubHttp`, the merge
// dispatch's conflict distinction, the CI-poll semantics).
//
// The HTTP client is injected at construction (the run/merge path passes the
// `TimedGitHubHttpClient(new FetchGitHubHttpClient())` the server/worker build),
// so the observability decorator stays in force. The contributor read + the
// `/contents` read live here too — both already existed as raw `githubHttp`
// requests in the run/merge path or its siblings — so the provider is the single
// place the GitHub forge surface for the lifecycle is reached.

import { resolveGithubToken } from "../credentials/githubTokenResolver.js";
import { parseCommitLogins } from "../workflow/reviewMerge/commitLogins.js";
import type { PullRequestContributors } from "../workflow/reviewMerge/governancePosture.js";
import { decodeBase64Content } from "../contracts/vcsProvider.js";
import type {
  OpenDraftPullRequestInput,
  OpenedPullRequest,
  PullRequestRef,
  PushBranchInput,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../contracts/vcsProvider.js";
import { pushWorkspaceBranchToGitHub } from "../workspace/githubPush.js";
import {
  GitHubPullRequestService,
  GitHubStatusService,
  parseGitHubPullRequestUrl,
  parseGitHubRepository,
  type GitHubHttpClient,
  type GitHubPullRequestChecks,
} from "./github.js";
import {
  GitHubReviewMergeService,
  type MergePullRequestResult,
  type ReviewVerdictResult,
  type SubmitReviewEvent,
} from "./githubReviewMerge.js";

function repoApiPath(repo: RepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function encodeRepoFilePath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

/**
 * The GitHub implementation of {@link VcsProvider}. Constructed with the shared
 * (timed) `GitHubHttpClient`; the per-call credential context is supplied by the
 * stage via {@link resolveToken}, exactly as the existing stage probes do.
 */
export class GitHubVcsProvider implements VcsProvider {
  private readonly pulls: GitHubPullRequestService;
  private readonly status: GitHubStatusService;
  private readonly reviewMerge: GitHubReviewMergeService;

  constructor(private readonly http: GitHubHttpClient) {
    this.pulls = new GitHubPullRequestService(http);
    this.status = new GitHubStatusService(http);
    this.reviewMerge = new GitHubReviewMergeService(http);
  }

  async resolveToken(creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    const resolved = await resolveGithubToken({
      secrets: creds.secrets,
      installation: creds.installation,
      staticRef: creds.staticRef,
      minter: creds.minter,
    });
    return { token: resolved.token, source: resolved.source, refresh: resolved.refresh };
  }

  parseRepository(repoUrl: string): RepoRef {
    return parseGitHubRepository(repoUrl);
  }

  parsePullRequest(prUrl: string): PullRequestRef {
    const parsed = parseGitHubPullRequestUrl(prUrl);
    return { repo: parsed.repo, number: parsed.pullNumber };
  }

  async pushBranch(input: PushBranchInput): Promise<void> {
    await pushWorkspaceBranchToGitHub({
      secrets: input.secrets,
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      repoUrl: input.repoUrl,
      branch: input.branch,
      credentialRef: input.credentialRef,
      token: input.token.token,
      timeoutMs: input.timeoutMs,
      sourceRef: input.sourceRef,
    });
  }

  async openDraftPullRequest(input: OpenDraftPullRequestInput): Promise<OpenedPullRequest> {
    const pr = await this.pulls.ensureDraftPullRequest({
      repo: input.repo,
      token: input.token.token,
      refreshToken: input.token.refresh,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    });
    return { number: pr.number, url: pr.url, reused: pr.reused };
  }

  async markReadyForReview(pr: PullRequestRef, token: ResolvedVcsToken): Promise<void> {
    await this.reviewMerge.markReadyForReview({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async readPullRequestChecks(pr: PullRequestRef, token: ResolvedVcsToken): Promise<GitHubPullRequestChecks> {
    return this.status.fetchPullRequestChecks({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async readReviewVerdict(pr: PullRequestRef, token: ResolvedVcsToken): Promise<ReviewVerdictResult> {
    return this.reviewMerge.fetchReviewVerdict({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async readPullRequestDiff(pr: PullRequestRef, token: ResolvedVcsToken): Promise<string> {
    return this.reviewMerge.fetchPullRequestDiff({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async submitReview(
    pr: PullRequestRef,
    event: SubmitReviewEvent,
    body: string,
    token: ResolvedVcsToken,
  ): Promise<void> {
    await this.reviewMerge.submitReview({
      repo: pr.repo,
      pullNumber: pr.number,
      event,
      body,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async listContributors(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestContributors> {
    const response = await this.http.request({
      method: "GET",
      path: repoApiPath(pr.repo, `/pulls/${pr.number}/commits`),
      token: token.token,
      refreshToken: token.refresh,
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR commits fetch failed: HTTP ${response.status}`);
    }
    return { logins: parseCommitLogins(response.body) };
  }

  async applyQueueLabel(pr: PullRequestRef, label: string, token: ResolvedVcsToken): Promise<void> {
    await this.reviewMerge.applyQueueLabel({
      repo: pr.repo,
      pullNumber: pr.number,
      label,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async mergePullRequest(
    pr: PullRequestRef,
    token: ResolvedVcsToken,
    mergeMethod?: "merge" | "squash" | "rebase",
  ): Promise<MergePullRequestResult> {
    return this.reviewMerge.mergePullRequest({
      repo: pr.repo,
      pullNumber: pr.number,
      mergeMethod,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  async readFileOnBranch(input: {
    repo: RepoRef;
    ref: string;
    path: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined> {
    const response = await this.http.request({
      method: "GET",
      path: repoApiPath(input.repo, `/contents/${encodeRepoFilePath(input.path)}?ref=${encodeURIComponent(input.ref)}`),
      token: input.token.token,
      refreshToken: input.token.refresh,
    });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub contents fetch failed: HTTP ${response.status}`);
    }
    const body = response.body as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") {
      return undefined;
    }
    return body.encoding === "base64" ? decodeBase64Content(body.content) : body.content;
  }
}
