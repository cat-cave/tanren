// P3-0008: GitHub API surface for the review→merge completion half of the run loop.
// Kept separate from providers/github.ts (the draft-PR + CI surface) so each file stays
// under the 500-line cap. Every method takes a token + optional refreshToken supplier so
// the P3-0003 resolver's 401-retry path flows through unchanged — no static-token reads.

import type { GitHubHttpClient, GitHubRepository } from "./github.js";
import { isTransientStatus } from "./githubRetry.js";
import { MergeAmbiguousError, MergeTransientError } from "./mergeOutcomeErrors.js";
import { parseMergeSha, parseMergedState, parseMessage } from "./githubReviewMergeParse.js";
import {
  parseMergeability,
  type GitHubMergeabilityResult,
  type GitHubUpdateBranchResult,
} from "./githubBranchFreshness.js";

export type { GitHubMergeabilityResult, GitHubUpdateBranchResult };

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

/**
 * How many times the double-merge guard re-`PUT`s after a transient 5xx WHEN the
 * reconcile read confirms the PR is still open + unmerged (so a re-PUT cannot
 * double-merge). Bounded so a persistent gateway failure surfaces loudly, not spins.
 */
const MERGE_TRANSIENT_RETRIES = 2;

function repoPath(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

/**
 * Review + merge GitHub operations: mark a draft PR ready-for-review, read the
 * latest reviews to derive a verdict, and perform a direct GitHub merge. The
 * merge method deliberately distinguishes a conflict (405/409 → recoverable)
 * from a hard failure so the merge dispatcher can route to the conflict-resolver
 * scaffolding.
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

  /**
   * Read the PR's per-file patches and concatenate them into a unified diff the
   * reviewer Answerer judges. Uses `GET /pulls/:n/files` (JSON, page-bounded)
   * rather than the raw `application/vnd.github.diff` media type so it flows
   * through the existing JSON HTTP client unchanged. Files with no `patch`
   * (binary, or truncated by GitHub) contribute a header line only.
   */
  async fetchPullRequestDiff(input: { repo: GitHubRepository; pullNumber: number } & TokenInput): Promise<string> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/files?per_page=100`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR files fetch failed: HTTP ${response.status}`);
    }
    return renderFilesDiff(response.body);
  }

  /**
   * Direct GitHub merge. A 200 is a merge; a 405 ("not mergeable") or 409 ("head
   * changed" / merge conflict) is reported as a conflict rather than a throw, so
   * the dispatcher can emit merge.conflict + a recoverable outcome. GitHub never
   * bypasses required checks here — a PR blocked by branch protection returns
   * 405 and surfaces as a non-merged result.
   *
   * GitHub-5xx resilience (double-merge guard): the merge `PUT` is NON-idempotent (a
   * 504 may have ALREADY merged), so we opt OUT of the client's blind transient retry
   * (`retryTransient: false`) and RE-READ the PR's `merged` state on a 5xx: confirmed
   * merged → success; confirmed open+unmerged, retries left → re-`PUT`; confirmed
   * open+unmerged, retries EXHAUSTED → THROW `MergeTransientError` (GAP #2d — the
   * coordinator infra-HOLDs + re-drives, NOT a `merge.failed` that strands a clean PR);
   * AMBIGUOUS (state unconfirmable) → THROW `MergeAmbiguousError` (a loud, operator-
   * visible halt that never auto-re-`PUT`s). A real 405/409 still returns a conflict.
   */
  async mergePullRequest(
    input: {
      repo: GitHubRepository;
      pullNumber: number;
      mergeMethod?: "merge" | "squash" | "rebase";
    } & TokenInput,
  ): Promise<MergePullRequestResult> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.http.request({
        method: "PUT",
        path: repoPath(input.repo, `/pulls/${input.pullNumber}/merge`),
        token: input.token,
        refreshToken: input.refreshToken,
        // Do NOT let the client auto-retry this non-idempotent write on a 5xx — a 504
        // may have merged. We reconcile against the PR's real state below instead.
        retryTransient: false,
        body: { merge_method: input.mergeMethod ?? "squash" },
      });
      if (response.status === 200) {
        return {
          merged: true,
          mergeSha: parseMergeSha(response.body),
          conflict: false,
          status: 200,
          message: "merged",
        };
      }
      if (isTransientStatus(response.status)) {
        // A gateway timeout on the PUT — re-read the authoritative state before deciding.
        const merged = await this.readMerged(input);
        if (merged.confirmed && merged.merged) {
          // The 504 raced a completed merge — treat as the success it was.
          return { merged: true, mergeSha: merged.sha, conflict: false, status: 200, message: "merged" };
        }
        if (merged.confirmed && merged.open && attempt < MERGE_TRANSIENT_RETRIES) {
          // Confirmed still open + not merged: safe to re-PUT (the merge never landed).
          continue;
        }
        if (merged.confirmed && merged.open) {
          // Re-PUTs exhausted but the reconcile read still POSITIVELY confirms open +
          // unmerged — a genuine-transient-not-failed outcome. THROW the typed transient
          // so the coordinator infra-HOLDs + re-drives (safe: the merge never landed),
          // NOT a terminal `merge.failed` dequeue that would strand a clean PR.
          throw new MergeTransientError(
            `merge PUT for PR #${input.pullNumber} hit a persistent transient HTTP ${response.status}; PR confirmed open + unmerged after ${MERGE_TRANSIENT_RETRIES} re-tries — holding for re-drive`,
          );
        }
        // AMBIGUOUS: the reconcile read could not confirm the state. The merge MAY have
        // landed — auto-re-driving could DOUBLE-MERGE. THROW the typed ambiguous error
        // → a LOUD operator-visible halt that never auto-re-PUTs.
        throw new MergeAmbiguousError(
          `merge PUT for PR #${input.pullNumber} hit a transient HTTP ${response.status} and the merged state could NOT be confirmed; refusing to auto-retry to avoid a double-merge — operator attention required`,
        );
      }
      const message = parseMessage(response.body) ?? `HTTP ${response.status}`;
      const conflict = response.status === 405 || response.status === 409;
      return { merged: false, conflict, status: response.status, message };
    }
  }

  /**
   * Re-read the PR's authoritative merged/open state — the double-merge guard's
   * reconciliation read after a transient 5xx on the merge PUT (`GET /pulls/{n}` is a
   * safe idempotent read). `confirmed` is whether the read itself succeeded (the
   * merged/open booleans are TRUSTWORTHY); a non-200 is `confirmed: false`, which the
   * caller treats as AMBIGUOUS (never re-PUTs blindly — the merge may have landed),
   * distinct from a confirmed open+unmerged (which IS safe to re-drive).
   */
  private async readMerged(
    input: { repo: GitHubRepository; pullNumber: number } & TokenInput,
  ): Promise<{ confirmed: boolean; merged: boolean; open: boolean; sha?: string }> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200) {
      // Could not confirm either way — report unconfirmed so the guard surfaces the
      // AMBIGUOUS (loud, non-auto-retry) outcome rather than re-PUTting blindly.
      return { confirmed: false, merged: false, open: false };
    }
    return { confirmed: true, ...parseMergedState(response.body) };
  }

  /**
   * P2a: read the PR's up-to-date / mergeability state. GitHub computes
   * `mergeable_state` asynchronously, so a freshly-opened/updated PR can briefly
   * report `unknown` (with `mergeable: null`); the caller treats that as "do not
   * assume current". `behind` is true when GitHub says the head is out of date
   * with base (`mergeable_state: "behind"`). The base/head refs are surfaced so
   * the rebase + events can name them without a second read.
   */
  async fetchMergeability(
    input: { repo: GitHubRepository; pullNumber: number } & TokenInput,
  ): Promise<GitHubMergeabilityResult> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR mergeability fetch failed: HTTP ${response.status}`);
    }
    return parseMergeability(response.body);
  }

  /**
   * P2a: bring the PR branch up to date with its base via GitHub's server-side
   * update-branch endpoint (`PUT /pulls/{n}/update-branch`). A 202 is an
   * accepted update (the branch advanced onto base — re-gate then merge); a 422
   * is GitHub reporting the update cannot be performed because of a real merge
   * conflict, surfaced as `conflict` (the caller routes to the resolver, NOT a
   * merge); a 204 means the branch was already current. Required-checks /
   * protection are never bypassed — this only advances the branch ref.
   */
  async updateBranch(
    input: { repo: GitHubRepository; pullNumber: number } & TokenInput,
  ): Promise<GitHubUpdateBranchResult> {
    const response = await this.http.request({
      method: "PUT",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}/update-branch`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status === 202) {
      return { outcome: "updated", message: parseMessage(response.body) ?? "branch update accepted" };
    }
    if (response.status === 204) {
      return { outcome: "up_to_date", message: "branch already up to date" };
    }
    // 422 (and 409) are GitHub reporting the update cannot proceed because of a
    // real conflict — a recoverable handoff to the resolver, NOT a hard failure.
    if (response.status === 422 || response.status === 409) {
      return { outcome: "conflict", message: parseMessage(response.body) ?? `HTTP ${response.status}` };
    }
    throw new Error(`GitHub update-branch failed: HTTP ${response.status}: ${parseMessage(response.body) ?? ""}`);
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

/**
 * Concatenate the per-file patches from a `GET /pulls/:n/files` JSON response
 * into a single unified-diff string. Each file contributes a `diff --git`
 * header plus its `patch` hunk (when present); a file without a patch (binary or
 * truncated) contributes the header alone so the reviewer still sees it changed.
 */
function renderFilesDiff(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub PR files response was not an array");
  }
  const sections: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const object = entry as Record<string, unknown>;
    const filename = typeof object["filename"] === "string" ? object["filename"] : "(unknown)";
    const patch = typeof object["patch"] === "string" ? object["patch"] : undefined;
    sections.push(patch === undefined ? `diff --git ${filename}` : `diff --git ${filename}\n${patch}`);
  }
  return sections.join("\n");
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
