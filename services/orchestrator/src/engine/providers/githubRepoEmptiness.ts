// GREENFIELD RE-ATTACH GUARD (apex v84) — the GitHub repo-EMPTINESS probe backing
// `GitHubCodeHost.isRepoBareAutoInit`. Extracted from `githubCodeHost.ts` so that
// file stays under the per-file line cap; it mirrors the other extracted GitHub
// side-effect helpers (`githubRepoCreate.ts`). A single function over the injected
// `GitHubHttpClient` + a resolved token, reading the commit list + (if needed) the
// root tree to decide whether the repo is the bare `auto_init` seed vs one already
// carrying a prior run's compose history. The token travels only in the request auth
// header (never in a body, a log, or a thrown message).

import { repoPath, withErrorDetail, type GitHubHttpClient } from "./github.js";
import type { CodeHostRepoRef, HostCommit } from "../contracts/codeHost.js";

/** The plaintext read token + an optional one-shot 401 re-mint (mirrors `CodeHostToken`). */
export interface RepoEmptinessToken {
  token: string;
  refresh?: () => Promise<string>;
}

/**
 * PROBE whether the repo is a BARE `auto_init` repo (a single "Initial commit" whose
 * tree carries nothing beyond a README) vs one already carrying history. Reads
 * `GET /commits?per_page=2`:
 *   - a 409 (GitHub's "Git Repository is empty") ⇒ a totally empty repo ⇒ BARE;
 *   - >1 commit ⇒ NOT bare (a prior run pushed compose commits on top);
 *   - exactly 1 commit whose message begins `tanren compose:` ⇒ NOT bare (a prior
 *     run's single materialize commit — belt-and-braces even if squashed to one);
 *   - exactly 1 commit ⇒ read its tree (`GET /git/trees/:sha`, non-recursive): BARE
 *     only if the tree has ≤1 entry AND that entry (if any) is a README blob;
 *     anything else (multiple files, a directory, a non-README file) ⇒ NOT bare.
 * `readCommit` is injected (the caller's `CodeHost.readCommit`) to resolve the single
 * commit's tree sha. The host HOSTS — this reads the commit graph, it never DECIDES.
 */
export async function githubRepoIsBareAutoInit(
  http: GitHubHttpClient,
  repo: CodeHostRepoRef,
  token: RepoEmptinessToken,
  readCommit: (repo: CodeHostRepoRef, sha: string) => Promise<HostCommit>,
): Promise<boolean> {
  const refresh = token.refresh;
  const commits = await http.request({
    method: "GET",
    path: repoPath(repo, "/commits?per_page=2"),
    token: token.token,
    ...(refresh !== undefined && { refreshToken: refresh }),
  });
  // A brand-new repo with NO commits at all: GitHub answers 409 "Git Repository is
  // empty". That is bare-er than auto_init — treat as bare (re-attach is safe).
  if (commits.status === 409) {
    return true;
  }
  if (commits.status !== 200 || !Array.isArray(commits.body)) {
    throw new Error(
      withErrorDetail(`GitHub commit list for ${repo.owner}/${repo.name} failed: HTTP ${commits.status}`, commits),
    );
  }
  // More than one commit ⇒ a prior run pushed compose commits on top of auto_init.
  if (commits.body.length > 1) {
    return false;
  }
  if (commits.body.length === 0) {
    return true;
  }
  const only = commits.body[0] as { sha?: unknown; commit?: { message?: unknown } };
  const message = typeof only.commit?.message === "string" ? only.commit.message : "";
  // A single `tanren compose:` commit is a prior run's squashed materialize — NOT bare.
  if (/^tanren compose:/iu.test(message.trimStart())) {
    return false;
  }
  if (typeof only.sha !== "string") {
    throw new TypeError(`GitHub commit list for ${repo.owner}/${repo.name} returned a malformed commit`);
  }
  // Read the single commit's tree; bare only if it carries at most a README blob.
  return treeIsBareReadme(http, repo, only.sha, token, readCommit);
}

/**
 * Read the commit's ROOT tree (non-recursive) and decide whether it is the bare
 * `auto_init` seed: ≤1 entry, and that entry (if present) a top-level README blob.
 * A directory, a second file, or a non-README file ⇒ real content ⇒ NOT bare.
 */
async function treeIsBareReadme(
  http: GitHubHttpClient,
  repo: CodeHostRepoRef,
  commitSha: string,
  token: RepoEmptinessToken,
  readCommit: (repo: CodeHostRepoRef, sha: string) => Promise<HostCommit>,
): Promise<boolean> {
  const commit = await readCommit(repo, commitSha);
  const response = await http.request({
    method: "GET",
    path: repoPath(repo, `/git/trees/${encodeURIComponent(commit.treeSha)}`),
    token: token.token,
    ...(token.refresh !== undefined && { refreshToken: token.refresh }),
  });
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error(
      withErrorDetail(`GitHub tree read for ${repo.owner}/${repo.name}@${commit.treeSha} failed`, response),
    );
  }
  const tree = (response.body as { tree?: unknown }).tree;
  if (!Array.isArray(tree)) {
    // No usable tree listing — fail CLOSED toward "not bare" (never silently reuse).
    return false;
  }
  if (tree.length === 0) {
    return true;
  }
  if (tree.length > 1) {
    return false;
  }
  const entry = tree[0] as { type?: unknown; path?: unknown };
  const isBlob = entry.type === "blob";
  const path = typeof entry.path === "string" ? entry.path : "";
  return isBlob && /^readme(\.[a-z]+)?$/iu.test(path);
}
