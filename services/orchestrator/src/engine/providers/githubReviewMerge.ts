// P3-0008: GitHub API surface for the review→merge completion half of the run
// loop. Kept separate from providers/github.ts (the draft-PR + CI surface) so
// each file stays focused under the 500-line cap. Every method takes a token +
// optional refreshToken supplier so the P3-0003 resolver's 401-retry path
// flows through unchanged — no static-token reads live here.

import type { GitHubHttpClient, GitHubRepository } from "./github.js";

/** A GitHub PR review state, normalized to the states the run loop reacts to. */
export type GitHubReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";

export interface GitHubReview {
  state: GitHubReviewState;
  reviewer?: string;
  body?: string;
  submittedAt?: string;
}

/** Aggregate review verdict the polling stage acts on. */
export type ReviewVerdict = "approved" | "changes_requested" | "pending";

export interface ReviewVerdictResult {
  verdict: ReviewVerdict;
  /** The latest review per the verdict (drives steering / event payload). */
  latest?: GitHubReview;
}

export interface MergePullRequestResult {
  merged: boolean;
  /** The merge commit sha when GitHub merged the PR. */
  mergeSha?: string;
  /** True when GitHub reported the merge could not be performed (405/409). */
  conflict: boolean;
  /** HTTP status + message for failed/non-conflict outcomes. */
  status: number;
  message: string;
}

interface TokenInput {
  token: string;
  refreshToken?: () => Promise<string>;
}

function repoPath(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

/**
 * Review + merge GitHub operations: mark a draft PR ready-for-review, read the
 * latest reviews to derive a verdict, apply a Mergify queue label, and perform
 * a direct GitHub merge. The merge method deliberately distinguishes a conflict
 * (405/409 → recoverable) from a hard failure so the merge dispatcher can route
 * to the conflict-resolver scaffolding.
 */
export class GitHubReviewMergeService {
  constructor(private readonly http: GitHubHttpClient) {}

  /**
   * Mark a draft PR ready for review. GitHub's "ready_for_review" is a GraphQL
   * mutation, but the REST PATCH `{ draft: false }` is the supported flip and is
   * idempotent — re-marking an already-ready PR is a no-op 200.
   */
  async markReadyForReview(input: { repo: GitHubRepository; pullNumber: number } & TokenInput): Promise<void> {
    const response = await this.http.request({
      method: "PATCH",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}`),
      token: input.token,
      refreshToken: input.refreshToken,
      body: { draft: false }
    });
    if (response.status !== 200) {
      throw new Error(`GitHub mark-ready failed: HTTP ${response.status}`);
    }
  }

  /** Fetch the PR reviews and reduce them to a single actionable verdict. */
  async fetchReviewVerdict(input: { repo: GitHubRepository; pullNumber: number } & TokenInput): Promise<ReviewVerdictResult> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/reviews`),
      token: input.token,
      refreshToken: input.refreshToken
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR reviews fetch failed: HTTP ${response.status}`);
    }
    const reviews = parseReviews(response.body);
    return reduceReviewVerdict(reviews);
  }

  /**
   * Apply a label to the PR (the Mergify queue trigger). Mergify watches for the
   * configured label and enqueues the PR; the merge itself happens off-platform.
   */
  async applyQueueLabel(input: { repo: GitHubRepository; pullNumber: number; label: string } & TokenInput): Promise<void> {
    const response = await this.http.request({
      method: "POST",
      path: repoPath(input.repo, `/issues/${input.pullNumber}/labels`),
      token: input.token,
      refreshToken: input.refreshToken,
      body: { labels: [input.label] }
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`GitHub label apply failed: HTTP ${response.status}`);
    }
  }

  /**
   * Direct GitHub merge. A 200 is a merge; a 405 ("not mergeable") or 409 ("head
   * changed" / merge conflict) is reported as a conflict rather than a throw, so
   * the dispatcher can emit merge.conflict + a recoverable outcome. GitHub never
   * bypasses required checks here — a PR blocked by branch protection returns
   * 405 and surfaces as a non-merged result.
   */
  async mergePullRequest(
    input: { repo: GitHubRepository; pullNumber: number; mergeMethod?: "merge" | "squash" | "rebase" } & TokenInput
  ): Promise<MergePullRequestResult> {
    const response = await this.http.request({
      method: "PUT",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/merge`),
      token: input.token,
      refreshToken: input.refreshToken,
      body: { merge_method: input.mergeMethod ?? "squash" }
    });
    if (response.status === 200) {
      return { merged: true, mergeSha: parseMergeSha(response.body), conflict: false, status: 200, message: "merged" };
    }
    const message = parseMessage(response.body) ?? `HTTP ${response.status}`;
    const conflict = response.status === 405 || response.status === 409;
    return { merged: false, conflict, status: response.status, message };
  }
}

function parseReviews(value: unknown): GitHubReview[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub PR reviews response was not an array");
  }
  return value.map(parseReview);
}

function parseReview(value: unknown): GitHubReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR review was not an object");
  }
  const object = value as Record<string, unknown>;
  const rawState = typeof object.state === "string" ? object.state.toLowerCase() : "pending";
  return {
    state: normalizeReviewState(rawState),
    reviewer: reviewerLogin(object.user),
    body: typeof object.body === "string" && object.body !== "" ? object.body : undefined,
    submittedAt: typeof object.submitted_at === "string" ? object.submitted_at : undefined
  };
}

function normalizeReviewState(state: string): GitHubReviewState {
  switch (state) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes_requested";
    case "commented":
      return "commented";
    case "dismissed":
      return "dismissed";
    default:
      return "pending";
  }
}

function reviewerLogin(user: unknown): string | undefined {
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return undefined;
  }
  const login = (user as Record<string, unknown>).login;
  return typeof login === "string" ? login : undefined;
}

/**
 * Reduce the review list to one verdict using GitHub's own precedence: the
 * latest non-comment review per reviewer wins, and any standing
 * changes_requested blocks; otherwise an approval approves; otherwise pending.
 */
export function reduceReviewVerdict(reviews: GitHubReview[]): ReviewVerdictResult {
  const latestPerReviewer = new Map<string, GitHubReview>();
  let anonymousLatest: GitHubReview | undefined;
  for (const review of reviews) {
    if (review.state === "commented" || review.state === "dismissed" || review.state === "pending") {
      continue;
    }
    if (review.reviewer === undefined) {
      anonymousLatest = review;
      continue;
    }
    latestPerReviewer.set(review.reviewer, review);
  }
  const effective = [...latestPerReviewer.values(), ...(anonymousLatest ? [anonymousLatest] : [])];
  const changes = effective.find((r) => r.state === "changes_requested");
  if (changes !== undefined) {
    return { verdict: "changes_requested", latest: changes };
  }
  const approval = effective.find((r) => r.state === "approved");
  if (approval !== undefined) {
    return { verdict: "approved", latest: approval };
  }
  return { verdict: "pending" };
}

function parseMergeSha(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const sha = (value as Record<string, unknown>).sha;
  return typeof sha === "string" ? sha : undefined;
}

function parseMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
