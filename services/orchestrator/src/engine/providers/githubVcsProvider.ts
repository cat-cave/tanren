// The GitHub VcsProvider impl. It COMPOSES the existing GitHub code
// (`GitHubPullRequestService`, `GitHubStatusService`, `GitHubReviewMergeService`,
// the `resolveGithubToken` resolver, the `pushWorkspaceBranchToGitHub` SSH push,
// `./githubActorIdentity`, and Track B's `./githubPublishCheck`) behind the
// provider-neutral seam — it wraps GitHub logic, never re-implements it, so
// behavior is preserved exactly. The HTTP client is injected at construction.

import { resolveVcsActorIdentity, resolveVcsToken } from "../credentials/vcsCredentials.js";
import {
  publishGitHubCheck,
  publishGitHubStatus,
  type PublishCheckInput,
  type PublishedCheck,
  type PublishStatusInput,
} from "./githubPublishCheck.js";
import { createGitHubRepository } from "./githubRepoCreate.js";
import { retargetGithubPullRequestBase } from "./githubRetargetPullRequestBase.js";
import { parseCommitLogins } from "../workflow/reviewMerge/commitLogins.js";
import type { PullRequestContributors } from "../workflow/reviewMerge/governancePosture.js";
import type {
  ActorIdentity,
  CreatedIssue,
  CreatedRepository,
  CreateIssueInput,
  CreateRepositoryInput,
  OpenDraftPullRequestInput,
  OpenedPullRequest,
  PullRequestMergeability,
  PullRequestRef,
  PullRequestState,
  PushBranchInput,
  RepoRef,
  ResolvedVcsToken,
  UpdateBranchResult,
  VcsCredentialContext,
  VcsProvider,
} from "../contracts/vcsProvider.js";
import { pushWorkspaceBranchToGitHub } from "../workspace/githubPush.js";
import { GitHubPullRequestService } from "./githubPullRequestReuse.js";
import {
  decodeBase64Content,
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

/**
 * Map GitHub's `mergeable_state` onto the provider-neutral mergeability state:
 * `behind` → rebase; `dirty` → conflict resolver; `clean`/`unstable`/`has_hooks`
 * → mergeable; `blocked` → non-freshness gate; `unknown`/`draft` → unknown.
 */
function mapMergeableState(state: string): PullRequestMergeability["state"] {
  switch (state) {
    case "behind":
      return "behind";
    case "dirty":
      return "dirty";
    case "clean":
    case "unstable":
    case "has_hooks":
      return "clean";
    case "blocked":
      return "blocked";
    default:
      return "unknown";
  }
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
 * stage via {@link resolveToken}, as the existing stage probes do.
 */
export class GitHubVcsProvider implements VcsProvider {
  private readonly pulls: GitHubPullRequestService;
  private readonly status: GitHubStatusService;
  private readonly reviewMerge: GitHubReviewMergeService;

  constructor(
    // §5: public-READABLE so the merge stage builds its `CodeHost` over the SAME client.
    readonly http: GitHubHttpClient,
  ) {
    this.pulls = new GitHubPullRequestService(http);
    this.status = new GitHubStatusService(http);
    this.reviewMerge = new GitHubReviewMergeService(http);
  }

  // §5a: token + identity resolution is credential PLUMBING (every host seam needs it),
  // not a forge op — the body lives in the standalone `credentials/vcsCredentials.ts`.
  // These two methods DELEGATE so not-yet-migrated `VcsProvider` callers still work.
  async resolveToken(creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return resolveVcsToken(this.http, creds);
  }

  async resolveActorIdentity(token: ResolvedVcsToken): Promise<ActorIdentity> {
    return resolveVcsActorIdentity(token);
  }

  parseRepository(repoUrl: string): RepoRef {
    return parseGitHubRepository(repoUrl);
  }

  parsePullRequest(prUrl: string): PullRequestRef {
    const parsed = parseGitHubPullRequestUrl(prUrl);
    return { repo: parsed.repo, number: parsed.pullNumber };
  }

  async readPullRequestState(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestState> {
    const state = await this.reviewMerge.readPullRequestState({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
    return {
      confirmed: state.confirmed,
      merged: state.merged,
      open: state.open,
      ...(state.sha !== undefined && { mergeSha: state.sha }),
    };
  }

  async createRepository(input: CreateRepositoryInput, token: ResolvedVcsToken): Promise<CreatedRepository> {
    // `POST /orgs/{owner}/repos` with auto_init; 422/403 → the contract's typed errors (in the helper).
    return createGitHubRepository(this.http, input, token);
  }

  async pushBranch(input: PushBranchInput): Promise<void> {
    await pushWorkspaceBranchToGitHub({
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      repoUrl: input.repoUrl,
      branch: input.branch,
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

  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    const response = await this.http.request({
      method: "POST",
      path: repoApiPath(input.repo, "/issues"),
      token: input.token.token,
      refreshToken: input.token.refresh,
      body: {
        title: input.title,
        body: input.body,
        ...(input.labels !== undefined && input.labels.length > 0 && { labels: [...input.labels] }),
      },
    });
    if (response.status !== 201 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub issue create failed: HTTP ${response.status}`);
    }
    const body = response.body as { number?: unknown; html_url?: unknown };
    if (typeof body.number !== "number" || typeof body.html_url !== "string") {
      throw new TypeError("GitHub issue create returned no number/url");
    }
    return { number: body.number, url: body.html_url };
  }

  // POST a native check-run / commit status; token never logged.
  async publishCheck(input: PublishCheckInput): Promise<PublishedCheck> {
    return publishGitHubCheck(this.http, input);
  }

  async publishStatus(input: PublishStatusInput): Promise<void> {
    await publishGitHubStatus(this.http, input);
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

  async readBranchChecks(input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<GitHubPullRequestChecks> {
    return this.status.fetchBranchChecks({
      repo: input.repo,
      branch: input.branch,
      token: input.token.token,
      refreshToken: input.token.refresh,
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

  async readMergeability(pr: PullRequestRef, token: ResolvedVcsToken): Promise<PullRequestMergeability> {
    const result = await this.reviewMerge.fetchMergeability({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
    return {
      state: mapMergeableState(result.mergeableState),
      behind: result.behind,
      baseBranch: result.baseBranch,
      headBranch: result.headBranch,
    };
  }

  async updateBranch(pr: PullRequestRef, token: ResolvedVcsToken): Promise<UpdateBranchResult> {
    const result = await this.reviewMerge.updateBranch({
      repo: pr.repo,
      pullNumber: pr.number,
      token: token.token,
      refreshToken: token.refresh,
    });
    return { outcome: result.outcome, message: result.message };
  }

  async readBranchHeadSha(input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<string | undefined> {
    const response = await this.http.request({
      method: "GET",
      path: repoApiPath(input.repo, `/git/ref/heads/${encodeURIComponent(input.branch)}`),
      token: input.token.token,
      refreshToken: input.token.refresh,
    });
    // 404 = ref gone (branch deleted/renamed): unreadable, the detect never invents a change.
    if (response.status === 404) return undefined;
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub head-sha read failed for ${input.branch}: HTTP ${response.status}`);
    }
    const object = (response.body as { object?: { sha?: unknown } }).object;
    return object !== undefined && typeof object.sha === "string" ? object.sha : undefined;
  }

  async retargetPullRequestBase(pr: PullRequestRef, newBase: string, token: ResolvedVcsToken): Promise<void> {
    await retargetGithubPullRequestBase({ http: this.http, pr, newBase, token });
  }

  async deleteBranch(repo: RepoRef, branch: string, token: ResolvedVcsToken): Promise<void> {
    const response = await this.http.request({
      method: "DELETE",
      path: repoApiPath(repo, `/git/refs/heads/${encodeURIComponent(branch)}`),
      token: token.token,
      refreshToken: token.refresh,
    });
    // 204 = deleted; 422/404 = ref already gone (idempotent best-effort cleanup).
    if (response.status === 204 || response.status === 422 || response.status === 404) {
      return;
    }
    throw new Error(`GitHub branch delete of ${branch} failed: HTTP ${response.status}`);
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
