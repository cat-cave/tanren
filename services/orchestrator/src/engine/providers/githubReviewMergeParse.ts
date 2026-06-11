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
