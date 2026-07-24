import { parseCheckRuns, parseCommitStatuses, parseRefObjectSha, parseRequiredContexts } from "./githubChecksParse.js";
import { parseBaseBranch, parsePullRequestHead, repoPath } from "./github/parse.js";
// Re-export the `/contents` base64 decoder (it lives in the contract module) so the
// GitHub provider sources every GitHub value-helper from `github.js` — one fewer dep there.
export { decodeBase64Content } from "../contracts/repoHostErrors.js";
// Re-export the shared App installation-token minter so the worker boot pulls the GitHub
// HTTP client + the minter from one provider module (the dependency-cap-friendly seam the
// retired `buildVcsProvider.js` convenience re-export used to provide).
export { GithubAppTokenMinter } from "./githubAppTokenMinter.js";
import { appendErrorDetail } from "./githubRetry.js";

export {
  asPullArray,
  githubHttpsRemote,
  parseGitHubPullRequestUrl,
  parseGitHubRepository,
  parsePullRequest,
  repoPath,
} from "./github/parse.js";
export { FetchGitHubHttpClient, type FetchGitHubHttpClientOptions } from "./github/httpClient.js";

export interface GitHubRepository {
  owner: string;
  name: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  draft: boolean;
  baseBranch?: string;
}

export interface GitHubPullRequestHead {
  sha: string;
  ref?: string;
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
}

export interface GitHubCommitStatus {
  context: string;
  state: string;
  url?: string;
}

export interface GitHubPullRequestChecks {
  head: GitHubPullRequestHead;
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  /**
   * required-check awareness: the branch-protection required status
   * check contexts for the PR's base branch, or `undefined` when the base
   * branch has no protection (or it could not be read). A run only passes when
   * every required context is green; when this is `undefined` the loop falls
   * back to "all observed checks green" (prior behavior).
   */
  requiredContexts?: string[];
}

export interface EnsureDraftPullRequestInput {
  repo: GitHubRepository;
  token: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  /** re-mint token + retry once on a 401. */
  refreshToken?: () => Promise<string>;
}

export interface EnsureDraftPullRequestResult extends GitHubPullRequest {
  reused: boolean;
}

export interface GitHubHttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  token: string;
  body?: unknown;
  /**
   * optional token-supplier. When provided and the request returns
   * 401 (e.g. an installation token expired/was revoked between mint and use),
   * the client re-mints once via `refreshToken()` and retries the request a
   * single time with the fresh token. Static-token callers omit this.
   */
  refreshToken?: () => Promise<string>;
  /**
   * GitHub-5xx resilience: when `false`, the client does NOT auto-retry a
   * transient gateway failure (502/503/504/408 or a transport error) for THIS
   * request — it surfaces the raw transient response/throw to the caller. The
   * default (omitted ⇒ retry) is safe for idempotent ops (GET / ref-reset /
   * PATCH / PUT-branch). A NON-idempotent write whose retry could double-apply
   * server-side (the `PUT /pulls/{n}/merge` — a 504 may have merged) sets this
   * `false` and re-checks the resource state itself instead. The 401 re-mint and
   * 403/429 rate-limit retries are unaffected (they re-send a request that did
   * not change state).
   */
  retryTransient?: boolean;
  /** Surface classified 403/429 to a durable caller without sleeping/retrying. */
  retryRateLimit?: boolean;
}

export interface GitHubHttpResponse {
  status: number;
  body: unknown;
  nextPagePath?: string;
  /**
   * rate-limit signal lifted from the response: a `Retry-After` (seconds), an exhausted
   * primary window (`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`), or a secondary/abuse
   * body (the bounded secondary default).
   */
  retryAfterMs?: number;
  /** Bounded in-request wait; durable callers use the exact `retryAfterMs`. */
  retryBackoffMs?: number;
  /**
   * Enriched non-2xx detail (the GitHub `message` + rate-limit headers) so a thrown `HTTP
   * <status>` carries WHY (the apex-v35 raw-`HTTP 403` diagnosis gap). `undefined` on a 2xx.
   */
  errorDetail?: string;
}

/** Append a response's enriched detail to a caller's `HTTP <status>` error string. */
export function withErrorDetail(base: string, response: GitHubHttpResponse): string {
  return appendErrorDetail(base, response.errorDetail);
}

export interface GitHubHttpClient {
  request(input: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

// `GitHubPullRequestService` (find / reuse / rebase the one PR per spec head) lives in
// `githubPullRequestReuse.ts` to keep this module under its 500-line cap. It is NOT
// re-exported here: that would form an import cycle (the reuse module already imports the
// shared helpers/types from this file), so importers pull the service from
// `./githubPullRequestReuse.js` directly.

export class GitHubStatusService {
  constructor(private readonly http: GitHubHttpClient) {}

  async fetchPullRequestChecks(input: {
    repo: GitHubRepository;
    token: string;
    pullNumber: number;
    refreshToken?: () => Promise<string>;
  }): Promise<GitHubPullRequestChecks> {
    const pull = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls/${input.pullNumber}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (pull.status !== 200) {
      throw new Error(withErrorDetail(`GitHub PR fetch failed: HTTP ${pull.status}`, pull));
    }
    const head = parsePullRequestHead(pull.body);
    const baseBranch = parseBaseBranch((pull.body as Record<string, unknown> | undefined)?.["base"]);

    return this.fetchChecksForSha({
      repo: input.repo,
      token: input.token,
      sha: head.sha,
      ...(baseBranch !== undefined && { protectedBranch: baseBranch }),
      ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
    });
  }

  /**
   * autonomy-engine.md §2d — speculative batch-check: read the CI/check
   * status of an arbitrary BRANCH ref (not a PR) — used to batch-check the prospective
   * merged state on the ephemeral speculative-integration branch. Resolves the
   * branch's HEAD SHA, then reads the SAME check-runs + commit-status endpoints
   * `fetchPullRequestChecks` does, gated by the branch's own protection required
   * contexts. Surfaced host-neutrally via `CodeHost.readBranchChecks` (decomposition §5e).
   */
  async fetchBranchChecks(input: {
    repo: GitHubRepository;
    token: string;
    branch: string;
    refreshToken?: () => Promise<string>;
  }): Promise<GitHubPullRequestChecks> {
    const refResponse = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/git/ref/heads/${encodeURIComponent(input.branch)}`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (refResponse.status !== 200) {
      throw new Error(
        withErrorDetail(`GitHub branch ref fetch failed for ${input.branch}: HTTP ${refResponse.status}`, refResponse),
      );
    }
    const sha = parseRefObjectSha(refResponse.body);
    if (sha === undefined) {
      throw new Error(`GitHub branch ref ${input.branch} had no object SHA`);
    }
    return this.fetchChecksForSha({
      repo: input.repo,
      token: input.token,
      sha,
      protectedBranch: input.branch,
      ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
    });
  }

  /**
   * Read the check-runs + commit statuses for a commit SHA (the shared core of the
   * PR-keyed and branch-keyed check reads), gated by `protectedBranch`'s required
   * contexts when supplied. Kept private so both callers parse checks identically.
   */
  private async fetchChecksForSha(input: {
    repo: GitHubRepository;
    token: string;
    sha: string;
    protectedBranch?: string;
    refreshToken?: () => Promise<string>;
  }): Promise<GitHubPullRequestChecks> {
    const [checkRuns, statuses] = await Promise.all([
      this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/commits/${encodeURIComponent(input.sha)}/check-runs`),
        token: input.token,
        refreshToken: input.refreshToken,
      }),
      this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/commits/${encodeURIComponent(input.sha)}/status`),
        token: input.token,
        refreshToken: input.refreshToken,
      }),
    ]);
    if (checkRuns.status !== 200) {
      throw new Error(`GitHub check-runs fetch failed: HTTP ${checkRuns.status}`);
    }
    if (statuses.status !== 200) {
      throw new Error(`GitHub commit status fetch failed: HTTP ${statuses.status}`);
    }

    const requiredContexts =
      input.protectedBranch === undefined
        ? undefined
        : await this.fetchRequiredContexts({
            repo: input.repo,
            token: input.token,
            baseBranch: input.protectedBranch,
            ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
          });

    return {
      head: { sha: input.sha },
      checkRuns: parseCheckRuns(checkRuns.body),
      statuses: parseCommitStatuses(statuses.body),
      requiredContexts,
    };
  }

  /**
   * read the branch-protection required status check contexts for a base
   * branch. `undefined` ONLY for a 404 — GitHub's signal the branch has NO protection
   * (legitimately "no required gating"; callers fall back to all-observed-green).
   * No-silent-fallback: any OTHER non-200 is a genuine ERROR, not "no gating" — a 403
   * (token lacks `Administration:read`) returned as `undefined` would DISABLE required-
   * check gating; a persistent 5xx survived the transient retry. So those THROW loudly.
   */
  async fetchRequiredContexts(input: {
    repo: GitHubRepository;
    token: string;
    baseBranch: string;
    refreshToken?: () => Promise<string>;
  }): Promise<string[] | undefined> {
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/branches/${encodeURIComponent(input.baseBranch)}/protection/required_status_checks`),
      token: input.token,
      refreshToken: input.refreshToken,
    });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error(
        withErrorDetail(
          `GitHub branch-protection read failed for ${input.baseBranch}: HTTP ${response.status}`,
          response,
        ),
      );
    }
    return parseRequiredContexts(response.body);
  }
}
