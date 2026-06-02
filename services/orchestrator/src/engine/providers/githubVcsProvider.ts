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

/**
 * Map GitHub's `mergeable_state` string onto the provider-neutral mergeability
 * state the merge stage gates on. `behind` → rebase; `dirty` → conflict
 * resolver; `clean`/`unstable`/`has_hooks` → mergeable (proceed). `blocked` is a
 * gating issue OTHER than freshness (failing required checks / pending review),
 * NOT a stale-branch problem. `unknown`/`draft` → unknown (do not assume current).
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

  async buildIntegrationBranch(input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    const { repo, token, baseBranch, integrationBranch, ancestors } = input;
    // 1. Resolve the real base SHA and (re)set the ephemeral integration ref to
    //    it — so a rebuild is never additive over a stale integration. NEVER
    //    touches `default_branch`; only the ephemeral ref is written.
    const baseSha = await this.refSha(repo, token, baseBranch);
    await this.resetRef(repo, token, integrationBranch, baseSha);

    // 2. Merge each ancestor's branch onto the integration ref in DAG order. A
    //    409 from the merge API is a real conflict BETWEEN this ancestor and what
    //    is already integrated (an earlier ancestor) — surface it here, early.
    const merged: string[] = [];
    const ancestorHeadShas: Record<string, string> = {};
    for (const ancestor of ancestors) {
      // Capture the ancestor's head SHA AT integration time (the divergence key the
      // change-percolation detect later compares the live head against, P2c-2).
      ancestorHeadShas[ancestor.specId] = await this.refSha(repo, token, ancestor.branch);
      const result = await this.mergeBranchInto(repo, token, integrationBranch, ancestor.branch);
      if (result === "conflict") {
        // The conflict is between THIS ancestor and what is already on the
        // integration ref. The immediately-prior integrated ancestor is the most
        // specific other side; with none yet integrated it is the base itself.
        const otherSpecId = merged.at(-1) ?? baseBranch;
        // The conflicting ancestor did not merge — drop its captured head SHA.
        delete ancestorHeadShas[ancestor.specId];
        return {
          outcome: "conflict",
          integrationBranch,
          mergedAncestors: merged,
          ancestorHeadShas,
          conflictBetween: { specId: ancestor.specId, otherSpecId },
          message: `ancestor ${ancestor.specId} (${ancestor.branch}) conflicts with the integration of ${otherSpecId} on ${integrationBranch}`,
        };
      }
      merged.push(ancestor.specId);
    }
    return {
      outcome: "integrated",
      integrationBranch,
      mergedAncestors: merged,
      ancestorHeadShas,
      message: `integrated ${merged.length} ancestor branch(es) onto ${integrationBranch}`,
    };
  }

  private async refSha(repo: RepoRef, token: ResolvedVcsToken, branch: string): Promise<string> {
    const response = await this.http.request({
      method: "GET",
      path: repoApiPath(repo, `/git/ref/heads/${encodeURIComponent(branch)}`),
      token: token.token,
      refreshToken: token.refresh,
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub ref read failed for ${branch}: HTTP ${response.status}`);
    }
    const object = (response.body as { object?: { sha?: unknown } }).object;
    if (object === undefined || typeof object.sha !== "string") {
      throw new Error(`GitHub ref read for ${branch} returned no sha`);
    }
    return object.sha;
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
    // 404 = the ref does not exist (the ancestor's branch was deleted/renamed): no
    // head to compare against — the detect treats it as unreadable, never invents a change.
    if (response.status === 404) return undefined;
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub head-sha read failed for ${input.branch}: HTTP ${response.status}`);
    }
    const object = (response.body as { object?: { sha?: unknown } }).object;
    return object !== undefined && typeof object.sha === "string" ? object.sha : undefined;
  }

  /** Create the integration ref at `sha`, or force-update it if it already exists. */
  private async resetRef(repo: RepoRef, token: ResolvedVcsToken, branch: string, sha: string): Promise<void> {
    const create = await this.http.request({
      method: "POST",
      path: repoApiPath(repo, "/git/refs"),
      token: token.token,
      refreshToken: token.refresh,
      body: { ref: `refs/heads/${branch}`, sha },
    });
    if (create.status === 201) {
      return;
    }
    // 422 = ref already exists; force it back to the base sha (idempotent rebuild).
    if (create.status === 422) {
      const update = await this.http.request({
        method: "PATCH",
        path: repoApiPath(repo, `/git/refs/heads/${encodeURIComponent(branch)}`),
        token: token.token,
        refreshToken: token.refresh,
        body: { sha, force: true },
      });
      if (update.status !== 200) {
        throw new Error(`GitHub integration ref reset failed for ${branch}: HTTP ${update.status}`);
      }
      return;
    }
    throw new Error(`GitHub integration ref create failed for ${branch}: HTTP ${create.status}`);
  }

  /** Merge `headBranch` into `base` (the integration ref). 409 ⇒ conflict. */
  private async mergeBranchInto(
    repo: RepoRef,
    token: ResolvedVcsToken,
    base: string,
    headBranch: string,
  ): Promise<"merged" | "conflict"> {
    const response = await this.http.request({
      method: "POST",
      path: repoApiPath(repo, "/merges"),
      token: token.token,
      refreshToken: token.refresh,
      body: { base, head: headBranch, commit_message: `tanren: speculatively integrate ${headBranch}` },
    });
    // 201 = a merge commit was created; 204 = nothing to merge (already current).
    if (response.status === 201 || response.status === 204) {
      return "merged";
    }
    if (response.status === 409) {
      return "conflict";
    }
    throw new Error(`GitHub speculative merge of ${headBranch} into ${base} failed: HTTP ${response.status}`);
  }

  async retargetPullRequestBase(pr: PullRequestRef, newBase: string, token: ResolvedVcsToken): Promise<void> {
    const response = await this.http.request({
      method: "PATCH",
      path: repoApiPath(pr.repo, `/pulls/${pr.number}`),
      token: token.token,
      refreshToken: token.refresh,
      body: { base: newBase },
    });
    // 200 = base updated (or already that base — GitHub returns the unchanged PR).
    if (response.status !== 200) {
      throw new Error(`GitHub PR base retarget to ${newBase} failed: HTTP ${response.status}`);
    }
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
