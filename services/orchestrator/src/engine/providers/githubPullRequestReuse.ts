// PR find / reuse / rebase, extracted from `github.ts` so the provider module stays
// under its 500-line file cap (the same extraction pattern as `githubRefReset.ts` /
// `githubReviewMergeParse.ts`). This is the single place that guarantees EXACTLY ONE
// open PR per spec-derived head branch across re-executions.
//
// The §2c hazard it resolves: a spec maps to one stable head branch
// (`defaultRunBranch(spec)`), so a change-percolation re-exec pushes the SAME head a
// prior run already opened a PR for. When the prior run was *speculative* its PR is
// based on the integration branch, but the re-exec is *non-speculative* (base = default
// branch). The lookup must therefore key on HEAD ONLY (not base) — a base-scoped query
// misses the superseded speculative PR, so a second `POST /pulls` is attempted and
// GitHub returns 422 ("a pull request already exists" for that head). Reusing + rebasing
// the existing PR keeps it to one canonical PR per spec and removes any need for a
// PR-close seam (there is never a second PR to collide with).

import type {
  EnsureDraftPullRequestInput,
  EnsureDraftPullRequestResult,
  GitHubHttpClient,
  GitHubPullRequest,
} from "./github.js";
import { asPullArray, parsePullRequest, repoPath } from "./github.js";

export class GitHubPullRequestService {
  constructor(private readonly http: GitHubHttpClient) {}

  async ensureDraftPullRequest(input: EnsureDraftPullRequestInput): Promise<EnsureDraftPullRequestResult> {
    const existing = await this.findOpenPullRequest(input);
    if (existing !== undefined) {
      return await this.reuseExistingPullRequest(input, existing);
    }

    const created = await this.http.request({
      method: "POST",
      path: repoPath(input.repo, "/pulls"),
      token: input.token,
      refreshToken: input.refreshToken,
      body: {
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
        draft: true,
      },
    });
    if (created.status === 201) {
      return { ...parsePullRequest(created.body), reused: false };
    }
    // A 422 on POST means an open PR already exists for this head (GitHub rejects a
    // second PR for the same head regardless of its base). Re-find by HEAD: the racing /
    // superseded PR is now visible — reuse it (re-pointing its base if the re-exec
    // changed the base, e.g. a §2c speculative→non-speculative re-exec) instead of
    // throwing. This guarantees exactly ONE PR per spec head.
    if (created.status === 422) {
      const afterRace = await this.findOpenPullRequest(input);
      if (afterRace !== undefined) {
        return await this.reuseExistingPullRequest(input, afterRace);
      }
    }
    throw new Error(`GitHub draft PR creation failed: HTTP ${created.status}`);
  }

  /**
   * Reuse the existing open PR for this head. When its base already matches the
   * requested base, return it as-is (normal reuse / speculative-stays-speculative). When
   * the base differs — the §2c case where a prior *speculative* run's PR (base =
   * integration branch) is re-executed *non-speculatively* (base = default branch) onto
   * the SAME spec-derived head — PATCH `/pulls/{number}` to re-point the PR's base before
   * returning it. The re-exec's force-push already refreshed the PR's diff; this fixes
   * the base so the one PR reflects the non-speculative target. The PATCH is idempotent:
   * re-running with the same base returns an unchanged 200 (and we skip it entirely when
   * the base already matches).
   */
  private async reuseExistingPullRequest(
    input: EnsureDraftPullRequestInput,
    existing: GitHubPullRequest,
  ): Promise<EnsureDraftPullRequestResult> {
    if (existing.baseBranch === input.baseBranch) {
      return { ...existing, reused: true };
    }
    const patched = await this.http.request({
      method: "PATCH",
      path: repoPath(input.repo, `/pulls/${existing.number}`),
      token: input.token,
      refreshToken: input.refreshToken,
      body: { base: input.baseBranch },
    });
    if (patched.status !== 200) {
      throw new Error(`GitHub PR base retarget to ${input.baseBranch} failed: HTTP ${patched.status}`);
    }
    return { ...parsePullRequest(patched.body), reused: true };
  }

  /**
   * Find the open PR for this head, querying by HEAD ONLY (not base). A given spec maps
   * to a single spec-derived head branch, so at most one open PR exists for it — and we
   * must surface it regardless of its current base or draft state, because a §2c re-exec
   * changes the base (integration branch → default branch) while keeping the head. The
   * old base-scoped query missed the superseded speculative PR and tried to POST a new
   * one → GitHub 422. Returning the head's open PR (whatever its base) lets the caller
   * reuse + rebase it into the single canonical PR for the spec.
   */
  private async findOpenPullRequest(input: EnsureDraftPullRequestInput): Promise<GitHubPullRequest | undefined> {
    const query = new URLSearchParams({
      state: "open",
      head: `${input.repo.owner}:${input.headBranch}`,
    });
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls?${query.toString()}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR lookup failed: HTTP ${response.status}`);
    }
    const pulls = asPullArray(response.body);
    return pulls.map((pull) => parsePullRequest(pull))[0];
  }
}
