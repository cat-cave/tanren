// Standalone, pure URL→neutral-ref parser (decomposition §5b) — the `parsePullRequest`
// primitive lifted OFF the retired `VcsProvider` interface (PR-9). A pure function (no
// host state, no credential), so a stage that holds a PR URL imports it directly rather
// than a host instance. It adapts the GitHub-shaped `github.ts` parser into the neutral
// `PullRequestRef` shape the run + merge lifecycle reasons over. (The repo-URL parse is
// `parseGitHubRepository` in `github.ts`, imported directly — `RepoRef = GitHubRepository`.)

import { parseGitHubPullRequestUrl } from "./github.js";
import type { PullRequestRef } from "../contracts/codeHostTypes.js";

/** Parse a pull-request URL into its {@link PullRequestRef} (`repo` + forge-local `number`). */
export function parsePullRequestRef(prUrl: string): PullRequestRef {
  const parsed = parseGitHubPullRequestUrl(prUrl);
  return { repo: parsed.repo, number: parsed.pullNumber };
}
