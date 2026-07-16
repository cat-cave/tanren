// Body parser for GitHubReviewMergeService, extracted so the service file stays under
// its line cap. Pure, defensive reader of GitHub REST response bodies.

/** GitHub's `{message}` string from an error/response body, if present. */
export function parseMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const message = (value as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : undefined;
}

/**
 * Durable forge review receipt from `POST /pulls/:n/reviews`. Fail-closed: every
 * field required for exact-head publication proof must be present and well-formed.
 * State is normalized to the host states Tanren treats as authoritative
 * (`approved` / `changes_requested`); COMMENT/pending are rejected (not a land signal).
 */
export interface ParsedSubmitReviewReceipt {
  forgeReviewId: string;
  forgeReviewState: "approved" | "changes_requested";
  forgeReviewUrl: string;
  headSha: string;
  reviewerLogin?: string;
}

export function parseSubmitReviewReceipt(value: unknown): ParsedSubmitReviewReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub submit-review response was not an object");
  }
  return parseAuthoritativeReviewObject(value as Record<string, unknown>, "submit-review response");
}

/**
 * One row from `GET /pulls/:n/reviews` (list). Unlike the submit receipt, list
 * rows may be COMMENT/pending/dismissed — callers filter. Missing identity fields
 * stay optional so reconcile can reject malformed Tanren-marked rows loudly.
 */
export interface ListedPullRequestReview {
  forgeReviewId: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  forgeReviewUrl?: string;
  headSha?: string;
  reviewerLogin?: string;
  body?: string;
}

export function parseListedReviews(value: unknown): ListedPullRequestReview[] {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub PR reviews list response was not an array");
  }
  return value.map((row, index) => parseListedReview(row, index));
}

function parseListedReview(value: unknown, index: number): ListedPullRequestReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`GitHub PR review list row ${index} was not an object`);
  }
  const object = value as Record<string, unknown>;
  const id = object["id"];
  const forgeReviewId = typeof id === "number" && Number.isFinite(id) ? String(id) : typeof id === "string" ? id : "";
  if (forgeReviewId === "") {
    throw new TypeError(`GitHub PR review list row ${index} carried no review id`);
  }
  const rawState = typeof object["state"] === "string" ? object["state"].toLowerCase() : "";
  const state = normalizeListedState(rawState);
  const forgeReviewUrl =
    typeof object["html_url"] === "string" && object["html_url"] !== "" ? object["html_url"] : undefined;
  const headSha =
    typeof object["commit_id"] === "string" && /^[0-9a-f]{40}$/iu.test(object["commit_id"])
      ? object["commit_id"]
      : undefined;
  const reviewerLogin = reviewerLoginFrom(object["user"]);
  const body = typeof object["body"] === "string" && object["body"] !== "" ? object["body"] : undefined;
  return {
    forgeReviewId,
    state,
    ...(forgeReviewUrl !== undefined && { forgeReviewUrl }),
    ...(headSha !== undefined && { headSha }),
    ...(reviewerLogin !== undefined && { reviewerLogin }),
    ...(body !== undefined && { body }),
  };
}

/**
 * Build a land-authoritative receipt from a listed review that already passed
 * reconcile filters. Fail-closed on any missing receipt field.
 */
export function receiptFromListedReview(review: ListedPullRequestReview): ParsedSubmitReviewReceipt {
  if (review.state !== "approved" && review.state !== "changes_requested") {
    throw new TypeError(`listed review ${review.forgeReviewId} state is not land-authoritative (${review.state})`);
  }
  if (review.forgeReviewUrl === undefined || review.forgeReviewUrl === "") {
    throw new TypeError(`listed review ${review.forgeReviewId} missing html_url`);
  }
  if (review.headSha === undefined || !/^[0-9a-f]{40}$/iu.test(review.headSha)) {
    throw new TypeError(`listed review ${review.forgeReviewId} missing exact 40-hex commit_id`);
  }
  return {
    forgeReviewId: review.forgeReviewId,
    forgeReviewState: review.state,
    forgeReviewUrl: review.forgeReviewUrl,
    headSha: review.headSha,
    ...(review.reviewerLogin !== undefined && review.reviewerLogin !== "" && { reviewerLogin: review.reviewerLogin }),
  };
}

function parseAuthoritativeReviewObject(object: Record<string, unknown>, label: string): ParsedSubmitReviewReceipt {
  const id = object["id"];
  const forgeReviewId = typeof id === "number" && Number.isFinite(id) ? String(id) : typeof id === "string" ? id : "";
  if (forgeReviewId === "") {
    throw new TypeError(`GitHub ${label} carried no review id`);
  }
  const rawState = typeof object["state"] === "string" ? object["state"].toLowerCase() : "";
  const forgeReviewState =
    rawState === "approved" ? "approved" : rawState === "changes_requested" ? "changes_requested" : undefined;
  if (forgeReviewState === undefined) {
    throw new TypeError(`GitHub ${label} state is not APPROVE/REQUEST_CHANGES (got ${rawState || "empty"})`);
  }
  const forgeReviewUrl = typeof object["html_url"] === "string" ? object["html_url"] : "";
  if (forgeReviewUrl === "") {
    throw new TypeError(`GitHub ${label} carried no html_url`);
  }
  const headSha = typeof object["commit_id"] === "string" ? object["commit_id"] : "";
  if (headSha === "" || !/^[0-9a-f]{40}$/iu.test(headSha)) {
    throw new TypeError(`GitHub ${label} carried no exact 40-hex commit_id`);
  }
  const reviewerLogin = reviewerLoginFrom(object["user"]);
  return {
    forgeReviewId,
    forgeReviewState,
    forgeReviewUrl,
    headSha,
    ...(reviewerLogin !== undefined && reviewerLogin !== "" && { reviewerLogin }),
  };
}

function normalizeListedState(state: string): "approved" | "changes_requested" | "commented" | "dismissed" | "pending" {
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

function reviewerLoginFrom(user: unknown): string | undefined {
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return undefined;
  }
  const login = (user as Record<string, unknown>)["login"];
  return typeof login === "string" && login !== "" ? login : undefined;
}
