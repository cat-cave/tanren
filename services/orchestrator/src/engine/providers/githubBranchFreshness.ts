// up-to-date enforcement: parse a GitHub PR-detail body into the branch
// freshness snapshot the merge stage gates on. Kept separate from
// githubReviewMerge.ts so that file stays under the 500-line architecture cap.

/**
 * GitHub's PR mergeability snapshot. `mergeableState` is the raw
 * `mergeable_state` string (`clean` / `behind` / `dirty` / `blocked` /
 * `unknown` / `unstable` / `draft`); `behind` is the derived boolean the
 * up-to-date check gates on. `baseBranch` / `headBranch` name the refs.
 */
export interface GitHubMergeabilityResult {
  mergeableState: string;
  behind: boolean;
  baseBranch: string;
  headBranch: string;
}

/** the outcome of GitHub's update-branch (server-side rebase-onto-base). */
export interface GitHubUpdateBranchResult {
  outcome: "updated" | "up_to_date" | "conflict";
  message: string;
}

/** Parse a GitHub PR detail body into the mergeability snapshot. */
export function parseMergeability(value: unknown): GitHubMergeabilityResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub PR response was not an object");
  }
  const object = value as Record<string, unknown>;
  const mergeableState = typeof object["mergeable_state"] === "string" ? object["mergeable_state"] : "unknown";
  // We treat ONLY the explicit `behind` state as behind — `unknown`/`null`
  // mergeability stays "unknown" so the caller re-reads rather than assuming
  // staleness.
  const behind = mergeableState === "behind";
  return {
    mergeableState,
    behind,
    baseBranch: parseRef(object["base"]),
    headBranch: parseRef(object["head"]),
  };
}

/** Lift a `ref` from a PR `base`/`head` object (`{ ref: "main", ... }`). */
function parseRef(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const ref = (value as Record<string, unknown>)["ref"];
  return typeof ref === "string" ? ref : "";
}
