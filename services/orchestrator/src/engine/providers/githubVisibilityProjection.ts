// The GitHub `VisibilityProjection` impl (tanren-owns-the-engine.md §0, §1, §6) —
// the BEST-EFFORT human-facing mirror of a change on the forge UI. It COMPOSES the
// SAME GitHub publish code the `GitHubVcsProvider` already wraps
// (`GitHubPullRequestService.ensureDraftPullRequest`, `publishGitHubStatus`,
// `GitHubReviewMergeService.submitReview`, `retargetGithubPullRequestBase`) into the
// purpose-shaped projection seam — it never re-implements GitHub logic.
//
// CRITICAL (§0): this is a MIRROR, not a gate. Each method here MAY reject (it talks
// to GitHub) — that is FINE and EXPECTED. The engine never holds this RAW impl: it
// only ever calls it through `harden()` (visibilityProjection.ts), which captures a
// rejection as a `ProjectionOutcome.failed` and CAN NEVER propagate it to the caller.
// So a projection failure here can never affect a recorded internal decision.
//
// SECURITY: the resolved token is passed only to the publish calls' auth header
// (never logged, never returned). The projection inputs carry only non-secret,
// operator/code-controlled fields (repo, branches, SHAs, summaries).

import type {
  ChangeRequestInput,
  MarkChangeRequestReadyInput,
  ProjectedChangeRequest,
  ProjectedTrackingIssue,
  PublishGateInput,
  PublishReviewInput,
  RetargetChangeRequestInput,
  TrackingIssueInput,
  VisibilityProjection,
} from "../contracts/visibilityProjection.js";
import type { RepoRef, ResolvedVcsToken, StatusState } from "../contracts/vcsProvider.js";
import type { GitHubHttpClient } from "./github.js";
import { publishGitHubStatus } from "./githubPublishCheck.js";
import { GitHubPullRequestService } from "./githubPullRequestReuse.js";
import { GitHubReviewMergeService } from "./githubReviewMerge.js";
import { retargetGithubPullRequestBase } from "./githubRetargetPullRequestBase.js";

/**
 * The context label of the gate verdict published to the forge as a commit status —
 * the SAME `tanren/gate` context the live native-gate publisher uses
 * (`publishGateVerdict.ts`), so the projection mirrors the verdict on the identical
 * PR-check surface.
 */
export const GATE_PROJECTION_CONTEXT = "tanren/gate";

/** GitHub caps a commit-status `description` at 140 chars; clamp the summary inside it. */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * Parse a `repoFullName` (`owner/name`) into the provider-neutral {@link RepoRef}.
 * The projection contract carries the repo as a flat `owner/name` string (it is
 * host-agnostic); GitHub's services want `{ owner, name }`. A malformed value is a
 * LOUD throw — captured by `harden()` as a `failed` outcome, never silently mapped.
 */
function parseRepoFullName(repoFullName: string): RepoRef {
  const slash = repoFullName.indexOf("/");
  const owner = slash === -1 ? "" : repoFullName.slice(0, slash);
  const name = slash === -1 ? "" : repoFullName.slice(slash + 1);
  if (owner === "" || name === "" || name.includes("/")) {
    throw new Error(`unsupported repoFullName (expected owner/name): ${repoFullName}`);
  }
  return { owner, name };
}

/** Clamp a status description to GitHub's commit-status limit (no secrets in the text). */
function clampDescription(text: string): string {
  return text.length <= STATUS_DESCRIPTION_MAX ? text : `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`;
}

/**
 * The GitHub implementation of the RAW {@link VisibilityProjection}. Constructed with
 * the shared `GitHubHttpClient` plus a token supplier (resolved the same way the live
 * publishers resolve it). Every method MAY reject — the engine reaches them ONLY
 * through `harden()`, which severs any rejection into a best-effort outcome.
 */
export class GitHubVisibilityProjection implements VisibilityProjection {
  private readonly pulls: GitHubPullRequestService;
  private readonly reviewMerge: GitHubReviewMergeService;

  constructor(
    private readonly http: GitHubHttpClient,
    /** Resolve the access token for the projection call — mirrors the live publish path. */
    private readonly resolveToken: () => Promise<ResolvedVcsToken>,
  ) {
    this.pulls = new GitHubPullRequestService(http);
    this.reviewMerge = new GitHubReviewMergeService(http);
  }

  // openOrUpdateChangeRequest = open-or-REUSE the single canonical draft PR for the
  // head branch (the `ensureDraftPullRequest` find-or-create+retarget the provider
  // already uses), returning the human-facing PR handle.
  async openOrUpdateChangeRequest(input: ChangeRequestInput): Promise<ProjectedChangeRequest> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    const pr = await this.pulls.ensureDraftPullRequest({
      repo,
      token: token.token,
      refreshToken: token.refresh,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body ?? "",
    });
    return { url: pr.url, number: pr.number };
  }

  // publishGate = post the `tanren/gate` COMMIT STATUS on the head SHA (the same
  // primitive `publishGateVerdict.ts` publishes through the provider — a status,
  // not a check-run, because a token credential cannot issue a check-run).
  async publishGate(input: PublishGateInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    const state: StatusState = input.verdict === "passed" ? "success" : "failure";
    await publishGitHubStatus(this.http, {
      repo,
      token,
      headSha: input.headSha,
      context: GATE_PROJECTION_CONTEXT,
      state,
      description: clampDescription(input.summary),
    });
  }

  // publishReview = submit a forge review COMMENT mirroring Tanren's recorded review
  // (the provider's `submitReview`). It is a COMMENT event: the projection mirrors the
  // review for humans; the merge decision is Tanren's, never the host review's state.
  async publishReview(input: PublishReviewInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    await this.reviewMerge.submitReview({
      repo,
      pullNumber: input.changeRequestNumber,
      event: "COMMENT",
      body: input.body,
      token: token.token,
      refreshToken: token.refresh,
    });
  }

  // retargetChangeRequest = re-point the PR's base branch (the provider's
  // `retargetPullRequestBase`, with its 422-reconcile-read), mirroring a base shift.
  async retargetChangeRequest(input: RetargetChangeRequestInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    await retargetGithubPullRequestBase({
      http: this.http,
      pr: { repo, number: input.changeRequestNumber },
      newBase: input.newBaseBranch,
      token,
    });
  }

  // openTrackingIssue = file ONE best-effort tracking issue on the repo (the SAME
  // `POST /issues` the provider's `createIssue` used, now on the projection seam —
  // the home for the post-merge-failure regression note). Best-effort: any GitHub
  // failure rejects here and is severed by `harden()` into a `failed` outcome, so
  // the post-merge watcher can tolerate a projection that does not support issues.
  async openTrackingIssue(input: TrackingIssueInput): Promise<ProjectedTrackingIssue> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    const response = await this.http.request({
      method: "POST",
      path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues`,
      token: token.token,
      refreshToken: token.refresh,
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

  // markChangeRequestReady = genuinely un-draft the PR mirror (the provider's
  // `markReadyForReview` — the GraphQL `markPullRequestReadyForReview` flip the
  // reuse service wraps; idempotent). Best-effort: severed by `harden()`.
  async markChangeRequestReady(input: MarkChangeRequestReadyInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    await this.reviewMerge.markReadyForReview({
      repo,
      pullNumber: input.changeRequestNumber,
      token: token.token,
      refreshToken: token.refresh,
    });
  }
}
