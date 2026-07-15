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
  const object = value as Record<string, unknown>;
  const id = object["id"];
  const forgeReviewId = typeof id === "number" && Number.isFinite(id) ? String(id) : typeof id === "string" ? id : "";
  if (forgeReviewId === "") {
    throw new TypeError("GitHub submit-review response carried no review id");
  }
  const rawState = typeof object["state"] === "string" ? object["state"].toLowerCase() : "";
  const forgeReviewState =
    rawState === "approved" ? "approved" : rawState === "changes_requested" ? "changes_requested" : undefined;
  if (forgeReviewState === undefined) {
    throw new TypeError(
      `GitHub submit-review response state is not APPROVE/REQUEST_CHANGES (got ${rawState || "empty"})`,
    );
  }
  const forgeReviewUrl = typeof object["html_url"] === "string" ? object["html_url"] : "";
  if (forgeReviewUrl === "") {
    throw new TypeError("GitHub submit-review response carried no html_url");
  }
  const headSha = typeof object["commit_id"] === "string" ? object["commit_id"] : "";
  if (headSha === "" || !/^[0-9a-f]{40}$/iu.test(headSha)) {
    throw new TypeError("GitHub submit-review response carried no exact 40-hex commit_id");
  }
  const user = object["user"];
  const reviewerLogin =
    typeof user === "object" && user !== null && !Array.isArray(user)
      ? typeof (user as Record<string, unknown>)["login"] === "string"
        ? ((user as Record<string, unknown>)["login"] as string)
        : undefined
      : undefined;
  return {
    forgeReviewId,
    forgeReviewState,
    forgeReviewUrl,
    headSha,
    ...(reviewerLogin !== undefined && reviewerLogin !== "" && { reviewerLogin }),
  };
}
