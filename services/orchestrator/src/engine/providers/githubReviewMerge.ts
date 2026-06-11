// GitHub API surface for the review half of the run loop: mark-ready (un-draft),
// fetch-review-verdict, submit-review. The merge/mergeability/update-branch grain it
// once also carried is GONE post-cutover (the native `MergeAuthority` lands via
// `CodeHost.landAuthorizedRef`, jj/`BaseShiftCoordinator` decide freshness — the
// VcsProvider→CodeHost decomposition removed the dead host-merge methods). Kept
// separate from providers/github.ts (the draft-PR + CI surface) so each file stays
// under the 500-line cap. Every method takes a token + optional refreshToken supplier so
// the resolver's 401-retry path flows through unchanged — no static-token reads.

import type { GitHubHttpClient, GitHubRepository } from "./github.js";
import { parseMessage } from "./githubReviewMergeParse.js";

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

/**
 * The GitHub review events the orchestrator submits. APPROVE + REQUEST_CHANGES
 * are the verdict-bearing events GitHub forbids on your OWN pull request (HTTP
 * 422 "Review Can not approve your own pull request"). COMMENT is the
 * self-PR-safe event: GitHub allows a COMMENT-event review on your own PR, so
 * the simulated reviewer — which pushes AND reviews the PR with the same bot
 * identity — posts its verdict as a COMMENT audit artifact and drives the
 * approve/request_changes decision INTERNALLY off the Answerer verdict.
 */
export type SubmitReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewVerdictResult {
  verdict: ReviewVerdict;
  /** The latest review per the verdict (drives steering / event payload). */
  latest?: GitHubReview;
}

interface TokenInput {
  token: string;
  refreshToken?: () => Promise<string>;
}

function repoPath(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

/**
 * Review GitHub operations: mark a draft PR ready-for-review, read the latest
 * reviews to derive a verdict, and submit a review (the simulated-reviewer COMMENT
 * audit artifact). The host-merge/mergeability/update-branch operations were removed
 * by the VcsProvider→CodeHost decomposition (the native `MergeAuthority` + jj own
 * the land + freshness path).
 */
export class GitHubReviewMergeService {
  constructor(private readonly http: GitHubHttpClient) {}

  /**
   * Mark a draft PR ready for review (genuinely un-draft it). GitHub's REST API
   * has NO supported way to un-draft a PR — a `PATCH /pulls/{n} { draft: false }`
   * is silently ignored and the PR stays `draft: true`, which makes `direct_merge`
   * fail (GitHub refuses to merge a draft). The ONLY supported flip is the
   * GraphQL `markPullRequestReadyForReview` mutation, which takes the PR's global
   * node id. So we first read the PR node id over REST, then issue the mutation.
   * Idempotent: re-marking an already-ready PR returns a GraphQL error that we
   * tolerate (the PR is already non-draft, which is the desired end state).
   */
  async markReadyForReview(input: { repo: GitHubRepository; pullNumber: number } & TokenInput): Promise<void> {
    const nodeId = await this.fetchPullRequestNodeId(input);
    const response = await this.http.request({
      method: "POST",
      path: "/graphql",
      token: input.token,
      refreshToken: input.refreshToken,
      body: {
        query: MARK_READY_FOR_REVIEW_MUTATION,
        variables: { pullRequestId: nodeId },
      },
    });
    if (response.status !== 200) {
      throw new Error(`GitHub mark-ready failed: HTTP ${response.status}`);
    }
    const error = firstGraphqlError(response.body);
    // A PR that is already non-draft is the desired end state — GitHub returns a
    // "not a draft pull request" error which we tolerate as idempotent success.
    if (error !== undefined && !isAlreadyReadyError(error)) {
      throw new Error(`GitHub mark-ready GraphQL error: ${error}`);
    }
  }

  /** Read the PR's GraphQL global node id (required by the ready mutation). */
  private async fetchPullRequestNodeId(
    input: { repo: GitHubRepository; pullNumber: number } & TokenInput,
  ): Promise<string> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200) {
      throw new Error(`GitHub mark-ready PR lookup failed: HTTP ${response.status}`);
    }
    const nodeId = parseNodeId(response.body);
    if (nodeId === undefined) {
      throw new Error("GitHub mark-ready: PR response carried no node_id");
    }
    return nodeId;
  }

  /** Fetch the PR reviews and reduce them to a single actionable verdict. */
  async fetchReviewVerdict(
    input: { repo: GitHubRepository; pullNumber: number } & TokenInput,
  ): Promise<ReviewVerdictResult> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/reviews`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR reviews fetch failed: HTTP ${response.status}`);
    }
    const reviews = parseReviews(response.body);
    return reduceReviewVerdict(reviews);
  }

  /**
   * Submit a REAL GitHub review on the PR (the simulated-reviewer write path).
   * `POST /repos/:owner/:repo/pulls/:n/reviews` with the event (COMMENT for the
   * simulated reviewer, since GitHub forbids APPROVE/REQUEST_CHANGES on your own
   * PR) and the reviewer reasoning as the body. The posted review is a genuine,
   * visible audit artifact on the PR; the simulated path drives the
   * approve/request_changes verdict internally off the Answerer rather than
   * reading it back from a review-state poll. A non-2xx response throws so the
   * stage fails loudly rather than silently skipping the review.
   */
  async submitReview(
    input: {
      repo: GitHubRepository;
      pullNumber: number;
      event: SubmitReviewEvent;
      body: string;
    } & TokenInput,
  ): Promise<void> {
    const response = await this.http.request({
      method: "POST",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/reviews`),
      token: input.token,
      refreshToken: input.refreshToken,
      body: { event: input.event, body: input.body },
    });
    if (response.status !== 200 && response.status !== 201) {
      const message = parseMessage(response.body) ?? `HTTP ${response.status}`;
      throw new Error(`GitHub submit-review failed: ${message}`);
    }
  }
}

function parseReviews(value: unknown): GitHubReview[] {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub PR reviews response was not an array");
  }
  return value.map((review) => parseReview(review));
}

function parseReview(value: unknown): GitHubReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR review was not an object");
  }
  const object = value as Record<string, unknown>;
  const rawState = typeof object["state"] === "string" ? object["state"].toLowerCase() : "pending";
  return {
    state: normalizeReviewState(rawState),
    reviewer: reviewerLogin(object["user"]),
    body: typeof object["body"] === "string" && object["body"] !== "" ? object["body"] : undefined,
    submittedAt: typeof object["submitted_at"] === "string" ? object["submitted_at"] : undefined,
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
  const login = (user as Record<string, unknown>)["login"];
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

/** The GraphQL mutation that genuinely un-drafts a PR (REST cannot do this). */
const MARK_READY_FOR_REVIEW_MUTATION = `mutation MarkReady($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest { isDraft }
  }
}`;

/** Lift the PR's GraphQL global node id from the REST PR payload. */
function parseNodeId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const nodeId = (value as Record<string, unknown>)["node_id"];
  return typeof nodeId === "string" && nodeId !== "" ? nodeId : undefined;
}

/** First GraphQL error message in a GraphQL response body, if any. */
function firstGraphqlError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const errors = (value as Record<string, unknown>)["errors"];
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  const first = errors[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return "unknown GraphQL error";
  }
  const message = (first as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : "unknown GraphQL error";
}

/**
 * Whether a GraphQL error means the PR is already non-draft. Re-marking a
 * ready PR is an error in GitHub's API ("... is not a draft pull request"), but
 * the desired end state (non-draft) already holds, so we tolerate it.
 */
function isAlreadyReadyError(message: string): boolean {
  return /not a draft/iu.test(message);
}
