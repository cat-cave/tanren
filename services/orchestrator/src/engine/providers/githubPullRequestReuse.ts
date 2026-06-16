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

/**
 * The branch being PR'd has NOTHING ahead of the base — GitHub rejects the open with a
 * 422 `{ code: "custom", message: "No commits between <base> and <head>" }`. This is NOT a
 * generic internal failure: it has exactly TWO legitimate causes the PR-creation stage
 * must handle gracefully (never a hard escalating `internal` strand) —
 *   (a) the spec's work is ALREADY PRESENT in the base (a prior iteration merged, or the
 *       base already satisfies the criteria) ⇒ the spec is effectively DONE → CONVERGE;
 *   (b) the writer genuinely produced NO commit this attempt (a degraded/slow codex
 *       returned nothing) ⇒ TRANSIENT → RE-DRIVE.
 * Thrown as a TYPED error (keyed off the GitHub error CODE + message, not a brittle
 * string sniff at the call site) so the PR-creation stage discriminates (a) vs (b) and
 * routes converge-or-redrive — mirroring the empty-diff accept at the checker layer (#586).
 * A 422 that is NOT this case (e.g. an empty-title `missing_field`) still throws the
 * generic loud error below.
 */
export class NoCommitsBetweenBaseAndHeadError extends Error {
  readonly baseBranch: string;
  readonly headBranch: string;

  constructor(baseBranch: string, headBranch: string) {
    super(`GitHub draft PR open rejected: no commits between ${baseBranch} and ${headBranch}`);
    this.name = "NoCommitsBetweenBaseAndHeadError";
    this.baseBranch = baseBranch;
    this.headBranch = headBranch;
  }
}

/**
 * Does GitHub's 422 body specifically signal "No commits between base and head"? Keys off
 * the structured error CODE (`custom`) + the message text GitHub returns for an empty PR —
 * NOT a bare substring of the top-level message, so an unrelated 422 (a `missing_field`
 * title, a malformed body) never gets mis-routed as a benign empty branch.
 */
function isNoCommitsBetween(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return false;
  }
  return errors.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const code = (entry as { code?: unknown }).code;
    const message = (entry as { message?: unknown }).message;
    return code === "custom" && typeof message === "string" && /no commits between/iu.test(message);
  });
}

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
      // A 422 whose error is specifically "No commits between <base> and <head>": the
      // pushed branch has NOTHING ahead of the base. This is NOT a generic internal
      // failure — it is either work-already-present (converge) or an empty writer output
      // (re-drive). Throw the TYPED error so the PR-creation stage discriminates + routes
      // converge-or-redrive; it must NEVER hard-strand as an escalating `internal` error.
      if (isNoCommitsBetween(created.body)) {
        throw new NoCommitsBetweenBaseAndHeadError(input.baseBranch, input.headBranch);
      }
    }
    // Surface GitHub's response body (errors/message), never just the status: a 422 that
    // is NOT "already exists" (e.g. apex v31's empty-title `missing_field`) is otherwise
    // invisible — the swallowed body sent the v31 diagnosis down a wrong path.
    const detail = created.body === undefined ? "(no body)" : JSON.stringify(created.body).slice(0, 400);
    throw new Error(`GitHub draft PR creation failed: HTTP ${created.status} — ${detail}`);
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
