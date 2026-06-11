// Build the real per-project `ProjectHostSeams` (`{ codeHost, visibility }`) over the
// SAME GitHub HTTP client the run's `VcsProvider` already holds — the decomposition
// bridge a live stage uses to route its code reads + forge-UI writes through the
// purpose-shaped seams (tanren-owns-the-engine.md §6, decomposition §2c) WITHOUT
// threading a second http client / credential plumbing down the stage.
//
// WHY a guard, not the adapter: the read-seam `VcsProviderCodeHost` deliberately does
// NOT serve the sha-addressed `readDiff` (it throws), and the
// `VcsProviderVisibilityProjection` adapter predates the PR-1 best-effort methods
// (`markChangeRequestReady` / `openTrackingIssue`). The real `GitHubCodeHost` +
// `GitHubVisibilityProjection` (built by `buildProjectHostSeams`) serve the full
// surface, so a stage migrating onto the seams constructs the REAL pair over the
// provider's existing client. This is the SAME `instanceof GitHubVcsProvider` guard the
// merge-authority land already uses to build its `CodeHost` (`mergeAuthorityBundleBuild`):
// a non-GitHub provider has no host yet → a LOUD throw, never a silent stand-in.

import { GitHubVcsProvider } from "./githubVcsProvider.js";
import { repoPath } from "./github.js";
import { buildProjectHostSeams, type ProjectHostSeams } from "./hostFactory.js";
import type { CodeHostRepoRef } from "../contracts/codeHost.js";
import type { GitHubHttpClient } from "./github.js";
import type { PullRequestRef, ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";

/**
 * Lift the shared `GitHubHttpClient` the run's `VcsProvider` already holds, so a stage
 * can drive the standalone host seams + the PR-2 `resolveVcsToken(http, creds)` resolver
 * over the SAME client (no second http client threaded down the stage). A non-GitHub
 * provider has no host yet → a LOUD throw, never a silent stand-in (the SAME guard the
 * merge-authority land uses). A future backend exposes its own client here.
 */
export function gitHubHttpOf(vcsProvider: VcsProvider): GitHubHttpClient {
  if (!(vcsProvider instanceof GitHubVcsProvider)) {
    throw new Error(
      `host seams require a GitHub host; the configured VcsProvider (${vcsProvider.constructor.name}) has no host impl`,
    );
  }
  return vcsProvider.http;
}

/**
 * Build the `{ codeHost, visibility }` pair for a stage that holds a `VcsProvider` + a
 * resolved-token supplier, over the provider's existing `GitHubHttpClient`. The seams
 * are token-free; the supplier is invoked per call so a long-lived seam never holds a
 * stale credential. A non-GitHub provider throws LOUDLY (a future backend constructs
 * its own host here).
 */
export function projectHostSeamsOver(
  vcsProvider: VcsProvider,
  resolveToken: () => Promise<ResolvedVcsToken>,
): ProjectHostSeams {
  return buildProjectHostSeams(gitHubHttpOf(vcsProvider), resolveToken);
}

/** The sha-addressed endpoints of an external change request — what `CodeHost.readDiff` compares. */
export interface ChangeRequestShas {
  baseSha: string;
  headSha: string;
}

/**
 * Resolve the sha-addressed base+head of a change request so the reviewer's diff read
 * can move onto the host-neutral `CodeHost.readDiff(repo, baseSha, headSha)` (decomposition
 * §1 #16). The OLD `readPullRequestDiff(pr, token)` fetched the PR-shaped `/pulls/{n}/files`
 * diff; the host-neutral seam compares two shas, so we resolve the PR's exact `base.sha`/
 * `head.sha` first (a single `GET /pulls/{n}`) and hand those to `readDiff`. Reading the
 * SHAs (not the branch refs) keeps the diff anchored to the EXACT PR head the reviewer
 * judges, even if the branches advance underneath. A non-GitHub provider throws LOUDLY.
 */
export async function readChangeRequestShas(
  vcsProvider: VcsProvider,
  pr: PullRequestRef,
  token: ResolvedVcsToken,
): Promise<ChangeRequestShas> {
  const http = gitHubHttpOf(vcsProvider);
  const repo: CodeHostRepoRef = { owner: pr.repo.owner, name: pr.repo.name };
  const response = await http.request({
    method: "GET",
    path: repoPath(repo, `/pulls/${pr.number}`),
    token: token.token,
    ...(token.refresh !== undefined && { refreshToken: token.refresh }),
  });
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error(`GitHub PR read for #${pr.number} failed: HTTP ${response.status}`);
  }
  const body = response.body as { base?: { sha?: unknown }; head?: { sha?: unknown } };
  const baseSha = body.base?.sha;
  const headSha = body.head?.sha;
  if (typeof baseSha !== "string" || typeof headSha !== "string" || baseSha === "" || headSha === "") {
    throw new TypeError(`GitHub PR read for #${pr.number} returned no base/head sha`);
  }
  return { baseSha, headSha };
}
