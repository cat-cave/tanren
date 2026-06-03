// Body parsers for GitHubReviewMergeService, extracted so the service file stays under
// its line cap. Pure, defensive readers of GitHub REST response bodies.

/** The merge commit sha from a `PUT /pulls/{n}/merge` 200 body, when present. */
export function parseMergeSha(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const sha = (value as Record<string, unknown>)["sha"];
  return typeof sha === "string" ? sha : undefined;
}

/**
 * Lift the merged/open state from a `GET /pulls/{n}` body for the merge double-merge
 * guard. `merged` is GitHub's boolean (the PR landed); `open` is `state === "open"`
 * (still mergeable — a re-PUT is safe). `merge_commit_sha` is the landed merge SHA
 * when present (used as the success SHA when the 504 raced a completed merge).
 */
export function parseMergedState(value: unknown): { merged: boolean; open: boolean; sha?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { merged: false, open: false };
  }
  const object = value as Record<string, unknown>;
  const merged = object["merged"] === true;
  const open = object["state"] === "open";
  const sha = typeof object["merge_commit_sha"] === "string" ? object["merge_commit_sha"] : undefined;
  return { merged, open, ...(sha !== undefined && { sha }) };
}

/** GitHub's `{message}` string from an error/response body, if present. */
export function parseMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const message = (value as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : undefined;
}
