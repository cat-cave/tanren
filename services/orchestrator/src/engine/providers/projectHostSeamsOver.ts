// Build the real per-project `ProjectHostSeams` (`{ codeHost, visibility }`) over the
// run's shared `GitHubHttpClient` — the decomposition bridge a live stage uses to route
// its code reads + forge-UI writes through the purpose-shaped seams
// (tanren-owns-the-engine.md §6, decomposition §2c) WITHOUT threading a second http
// client / credential plumbing down the stage.
//
// Since PR-9 retired the `VcsProvider` interface, a stage threads the `GitHubHttpClient`
// directly (the SAME client the worker boot builds once), so this is a thin adapter over
// `buildProjectHostSeams` plus the PR's sha-addressed base/head read the reviewer diff
// needs. A future backend threads its own host client + builds its own seams.

import { repoPath } from "./github.js";
import { buildProjectHostSeams, type ProjectHostSeams } from "./hostFactory.js";
import type { CodeHostRepoRef } from "../contracts/codeHost.js";
import type { GitHubHttpClient } from "./github.js";
import type { PullRequestRef, ResolvedVcsToken } from "../contracts/codeHostTypes.js";

/**
 * Build the `{ codeHost, visibility }` pair for a stage that holds the run's
 * `GitHubHttpClient` + a resolved-token supplier. The seams are token-free; the supplier
 * is invoked per call so a long-lived seam never holds a stale credential.
 */
export function projectHostSeamsOver(
  http: GitHubHttpClient,
  resolveToken: () => Promise<ResolvedVcsToken>,
): ProjectHostSeams {
  return buildProjectHostSeams(http, resolveToken);
}

/** The sha-addressed endpoints of an external change request — what `CodeHost.readDiff` compares. */
export interface ChangeRequestShas {
  baseSha: string;
  headSha: string;
}

/**
 * Resolve the sha-addressed base+head of a change request so the reviewer's diff read
 * can move onto the host-neutral `CodeHost.readDiff(repo, baseSha, headSha)` (decomposition
 * §1 #16). The host-neutral seam compares two shas, so we resolve the PR's exact `base.sha`/
 * `head.sha` first (a single `GET /pulls/{n}`) and hand those to `readDiff`. Reading the
 * SHAs (not the branch refs) keeps the diff anchored to the EXACT PR head the reviewer
 * judges, even if the branches advance underneath.
 */
export async function readChangeRequestShas(
  http: GitHubHttpClient,
  pr: PullRequestRef,
  token: ResolvedVcsToken,
): Promise<ChangeRequestShas> {
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
