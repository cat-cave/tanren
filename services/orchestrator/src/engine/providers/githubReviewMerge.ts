// GitHub API surface for the review half of the run loop: mark-ready (un-draft),
// fetch-review-verdict, submit-review. The merge/mergeability/update-branch grain it
// once also carried is GONE post-cutover (the native `MergeAuthority` lands via
// `CodeHost.landAuthorizedRef`, jj/`BaseShiftCoordinator` decide freshness — the
// VcsProvider→CodeHost decomposition removed the dead host-merge methods). Kept
// separate from providers/github.ts (the draft-PR + CI surface) so each file stays
// under the 500-line cap. Every method takes a token + optional refreshToken supplier so
// the resolver's 401-retry path flows through unchanged — no static-token reads.

import type { GitHubHttpClient, GitHubRepository } from "./github.js";
import {
  parseListedReviews,
  parseMessage,
  parseSubmitReviewReceipt,
  type ListedPullRequestReview,
  type ParsedSubmitReviewReceipt,
} from "./githubReviewMergeParse.js";

export type { ListedPullRequestReview } from "./githubReviewMergeParse.js";

/** GitHub list page size for review reconcile (host max is 100). */
export const LIST_REVIEWS_PER_PAGE = 100;

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
 * The GitHub review events the orchestrator submits.
 *
 * Strict simulated review (gv-2) posts real `APPROVE` / `REQUEST_CHANGES` with a
 * distinct reviewer identity (GitHub forbids self-APPROVE/REQUEST_CHANGES on the
 * same identity that opened the PR). `COMMENT` remains only for best-effort
 * forge-UI mirrors that are never land-authoritative.
 */
export type SubmitReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** Durable receipt returned by a successful `submitReview` (exact-head bound). */
export type SubmittedReviewReceipt = ParsedSubmitReviewReceipt;

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
 * Review GitHub operations: mark a draft PR ready for review, read the latest
 * reviews to derive a verdict, and submit a review. Strict simulated review
 * (gv-2) posts REAL `APPROVE` / `REQUEST_CHANGES` (the land-authoritative
 * artifact) with a distinct reviewer identity; `COMMENT` remains only a
 * best-effort forge-UI mirror that is never land-authoritative. The host-merge
 * /mergeability/update-branch operations were removed by the VcsProvider→
 * CodeHost decomposition (the native `MergeAuthority` + jj own the land +
 * freshness path).
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
    const reviews = await this.listPullRequestReviews(input);
    return reduceReviewVerdict(
      reviews.map((r) => ({
        state: r.state,
        reviewer: r.reviewerLogin,
        body: r.body,
      })),
    );
  }

  /**
   * List every PR review with progress-based pagination (`per_page=100`).
   * Each non-empty page must introduce new review ids (progress); a repeated
   * id or malformed body fails loud (silent truncation/stuck page would hide
   * a conflicting Tanren review). Exhaustion is a short page (`length < 100`).
   */
  async listPullRequestReviews(
    input: { repo: GitHubRepository; pullNumber: number } & TokenInput,
  ): Promise<ListedPullRequestReview[]> {
    const all: ListedPullRequestReview[] = [];
    const seenIds = new Set<string>();
    let page = 1;
    for (;;) {
      const response = await this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/pulls/${input.pullNumber}/reviews?per_page=${LIST_REVIEWS_PER_PAGE}&page=${page}`),
        token: input.token,
        refreshToken: input.refreshToken,
      });
      if (response.status !== 200) {
        throw new Error(`GitHub PR reviews list failed: HTTP ${response.status}`);
      }
      let pageRows: ListedPullRequestReview[];
      try {
        pageRows = parseListedReviews(response.body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`GitHub PR reviews list malformed: ${message}`, { cause: err });
      }
      for (const row of pageRows) {
        if (seenIds.has(row.forgeReviewId)) {
          throw new Error(
            `GitHub PR reviews list stuck/repeated id ${row.forgeReviewId} on page ${page}; cannot reconcile safely`,
          );
        }
        seenIds.add(row.forgeReviewId);
      }
      all.push(...pageRows);
      if (pageRows.length < LIST_REVIEWS_PER_PAGE) {
        return all;
      }
      page += 1;
    }
  }

  /**
   * Submit a REAL GitHub review on the PR and return the durable forge receipt.
   * `POST /repos/:owner/:repo/pulls/:n/reviews` with the event + body, optionally
   * pin-bound to `commitId` (exact head SHA). A non-2xx response throws; a 2xx
   * with a missing/malformed id/state/url/commit_id also throws (fail closed —
   * no silent skip). Callers that require land-authoritative publication MUST
   * use `APPROVE`/`REQUEST_CHANGES` with a distinct reviewer identity.
   *
   * Non-COMMENT submits disable transport auto-retry (`retryTransient: false`):
   * a 504 may have accepted the review server-side; the convergent publisher
   * re-lists and reclaims instead of double-POSTing.
   */
  async submitReview(
    input: {
      repo: GitHubRepository;
      pullNumber: number;
      event: SubmitReviewEvent;
      body: string;
      /** Exact head SHA the review is for — binds the receipt to the reviewed commit. */
      commitId?: string;
    } & TokenInput,
  ): Promise<SubmittedReviewReceipt | undefined> {
    const response = await this.http.request({
      method: "POST",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/reviews`),
      token: input.token,
      refreshToken: input.refreshToken,
      // COMMENT is still a non-authoritative mirror; APPROVE/REQUEST_CHANGES must
      // not auto-retry on gateway errors (double-POST risk).
      ...(input.event !== "COMMENT" && { retryTransient: false }),
      body: {
        event: input.event,
        body: input.body,
        ...(input.commitId !== undefined && input.commitId !== "" && { commit_id: input.commitId }),
      },
    });
    if (response.status !== 200 && response.status !== 201) {
      const message = parseMessage(response.body) ?? `HTTP ${response.status}`;
      throw new Error(`GitHub submit-review failed: ${message}`);
    }
    // COMMENT is a best-effort forge-UI mirror only — no land-authoritative receipt.
    if (input.event === "COMMENT") {
      return undefined;
    }
    return parseSubmitReviewReceipt(response.body);
  }
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
