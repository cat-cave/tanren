// P2·0: the GitHub VcsProvider impl. It COMPOSES the existing GitHub code —
// `GitHubPullRequestService` (draft-PR), `GitHubStatusService` (CI/checks),
// `GitHubReviewMergeService` (mark-ready / reviews / diff / label / merge), the
// `resolveGithubToken` resolver (App-first + 401-refresh), and the
// `pushWorkspaceBranchToGitHub` SSH push — behind the provider-neutral
// `VcsProvider` seam. It DOES NOT re-implement any GitHub logic; it wraps it, so
// behavior is preserved exactly (token-via-stdin clone auth, the GraphQL ready
// mutation, the timed HTTP wrapper, the merge conflict distinction, CI-poll).
//
// The HTTP client is injected at construction so the observability decorator stays
// in force. The contributor + `/contents` reads live here too — the provider is the
// single place the forge surface for the lifecycle is reached. MERGE-SAFETY's
// `resolveActorIdentity` (the self-identity read) composes `./githubActorIdentity`.

import { setTimeout as sleepFor } from "node:timers/promises";
import { resolveGithubToken } from "../credentials/githubTokenResolver.js";
import { RefResetPermanentError, refReadStatusError, resetRef } from "./githubRefReset.js";
import { invokeTokenIdentity, resolveGithubActorIdentity } from "./githubActorIdentity.js";
import { setRepoActionsSecret } from "./actionsSecretSeal.js";
import { createGitHubRepository } from "./githubRepoCreate.js";
import { parseCommitLogins } from "../workflow/reviewMerge/commitLogins.js";
import type { PullRequestContributors } from "../workflow/reviewMerge/governancePosture.js";
import { decodeBase64Content } from "../contracts/vcsProvider.js";
import type {
  ActorIdentity,
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  CreatedIssue,
  CreatedRepository,
  CreateIssueInput,
  CreateRepositoryInput,
  OpenDraftPullRequestInput,
  OpenedPullRequest,
  PullRequestMergeability,
  PullRequestRef,
  PushBranchInput,
  RepoRef,
  ResolvedVcsToken,
  SetActionsSecretInput,
  UpdateBranchResult,
  VcsCredentialContext,
  VcsProvider,
} from "../contracts/vcsProvider.js";
import { pushWorkspaceBranchToGitHub } from "../workspace/githubPush.js";
import { GitHubPullRequestService } from "./githubPullRequestReuse.js";
import {
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
 * Map GitHub's `mergeable_state` onto the provider-neutral mergeability state the
 * merge stage gates on: `behind` → rebase; `dirty` → conflict resolver;
 * `clean`/`unstable`/`has_hooks` → mergeable; `blocked` → a non-freshness gate
 * (failing required checks / pending review); `unknown`/`draft` → unknown.
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

  /** Test seam: sleep used between the internal ref-reset retries (real timer in prod). */
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly http: GitHubHttpClient,
    opts?: { sleep?: (ms: number) => Promise<void> },
  ) {
    this.pulls = new GitHubPullRequestService(http);
    this.status = new GitHubStatusService(http);
    this.reviewMerge = new GitHubReviewMergeService(http);
    this.sleep = opts?.sleep ?? ((ms) => sleepFor(ms));
  }

  async resolveToken(creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    const resolved = await resolveGithubToken({
      secrets: creds.secrets,
      installation: creds.installation,
      staticRef: creds.staticRef,
      minter: creds.minter,
    });
    const token: ResolvedVcsToken = {
      token: resolved.token,
      source: resolved.source,
      refresh: resolved.refresh,
      // MERGE-SAFETY: the identity supplier closes over the SAME creds that
      // resolved the token (run git author + merge identity set can't disagree). Lazy.
      identity: () => resolveGithubActorIdentity(this.http, token, creds),
    };
    return token;
  }

  async resolveActorIdentity(token: ResolvedVcsToken): Promise<ActorIdentity> {
    return invokeTokenIdentity(token);
  }

  parseRepository(repoUrl: string): RepoRef {
    return parseGitHubRepository(repoUrl);
  }

  parsePullRequest(prUrl: string): PullRequestRef {
    const parsed = parseGitHubPullRequestUrl(prUrl);
    return { repo: parsed.repo, number: parsed.pullNumber };
  }

  async createRepository(input: CreateRepositoryInput, token: ResolvedVcsToken): Promise<CreatedRepository> {
    // `POST /orgs/{owner}/repos` with auto_init; 422/403 → the contract's typed
    // errors (delegated to the helper so the provider stays under the line cap).
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

  async setActionsSecret(input: SetActionsSecretInput): Promise<void> {
    // Read the Actions public key → sealed-box encrypt → PUT (plaintext stays inside the encrypted body).
    await setRepoActionsSecret(this.http, input);
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
    // 1. (Re)set the ephemeral integration ref to the real base SHA so a rebuild is
    //    never additive over a stale integration. NEVER touches `default_branch`.
    const baseSha = await this.refSha(repo, token, baseBranch);
    await this.resetRef(repo, token, integrationBranch, baseSha);

    // 2. Merge each ancestor's branch onto the integration ref in DAG order. A 409
    //    is a real conflict BETWEEN this ancestor and an earlier integrated one —
    //    surfaced here, early.
    const merged: string[] = [];
    const ancestorHeadShas: Record<string, string> = {};
    for (const ancestor of ancestors) {
      // Capture the ancestor's head SHA AT integration time (the P2c-2 divergence key).
      ancestorHeadShas[ancestor.specId] = await this.refSha(repo, token, ancestor.branch);
      const result = await this.mergeBranchInto(repo, token, integrationBranch, ancestor.branch);
      if (result === "conflict") {
        // The other side is the immediately-prior integrated ancestor (or the base).
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
      // TYPED (see refReadStatusError): a 404 (deleted/renamed ancestor branch) / 403 is
      // PERMANENT — an untyped Error defaulted retriable → re-drove the 3s infra loop
      // forever on a missing branch; a transient 5xx stays retriable.
      throw refReadStatusError("ref read", branch, response.status);
    }
    const object = (response.body as { object?: { sha?: unknown } }).object;
    if (object === undefined || typeof object.sha !== "string") {
      // A 200 with no sha is a malformed/permanent response, not a transient blip.
      throw new RefResetPermanentError(`GitHub ref read for ${branch} returned no sha`);
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
    // 404 = ref gone (branch deleted/renamed): unreadable, the detect never invents a change.
    if (response.status === 404) return undefined;
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      throw new Error(`GitHub head-sha read failed for ${input.branch}: HTTP ${response.status}`);
    }
    const object = (response.body as { object?: { sha?: unknown } }).object;
    return object !== undefined && typeof object.sha === "string" ? object.sha : undefined;
  }

  /**
   * (Re)set the ephemeral integration ref to `sha` (create, or force-update if it
   * exists). Delegates to the race-safe {@link resetRef} (body-message classification +
   * bounded internal retry on a transient HTTP 422 — Bug 1), passing the injected sleep.
   */
  private async resetRef(repo: RepoRef, token: ResolvedVcsToken, branch: string, sha: string): Promise<void> {
    await resetRef({ http: this.http, sleep: this.sleep, repo, token, branch, sha });
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
    // TYPED (see refSha): a 404 (the head/base branch was deleted/renamed mid-batch) or
    // a 403 is PERMANENT — without the typed error the untyped throw defaulted retriable
    // and re-drove the 3s infra loop forever on a missing branch. A transient 5xx stays
    // retriable so a genuine gateway blip still self-heals. The 409-conflict path above
    // is unchanged (a genuine conflict is NOT an infra error).
    throw refReadStatusError("speculative merge", `${headBranch} into ${base}`, response.status);
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
