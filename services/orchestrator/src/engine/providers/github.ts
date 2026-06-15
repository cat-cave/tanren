import { setTimeout as sleepFor } from "node:timers/promises";
import { parseCheckRuns, parseCommitStatuses, parseRefObjectSha, parseRequiredContexts } from "./githubChecksParse.js";
// Re-export the `/contents` base64 decoder (it lives in the contract module) so the
// GitHub provider sources every GitHub value-helper from `github.js` — one fewer dep there.
export { decodeBase64Content } from "../contracts/repoHostErrors.js";
// Re-export the shared App installation-token minter so the worker boot pulls the GitHub
// HTTP client + the minter from one provider module (the dependency-cap-friendly seam the
// retired `buildVcsProvider.js` convenience re-export used to provide).
export { GithubAppTokenMinter } from "./githubAppTokenMinter.js";
import {
  appendErrorDetail,
  buildErrorDetail,
  DEFAULT_RATE_LIMIT_RETRIES,
  DEFAULT_TRANSIENT_RETRIES,
  headerGetter,
  isTransientStatus,
  rateLimitBackoffMs,
  TRANSIENT_BACKOFF_MS,
} from "./githubRetry.js";

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
}

export interface GitHubHttpResponse {
  status: number;
  body: unknown;
  /**
   * rate-limit signal lifted from the response: a `Retry-After` (seconds), an exhausted
   * primary window (`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`), or a secondary/abuse
   * body (the bounded secondary default).
   */
  retryAfterMs?: number;
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

// The rate-limit + transient-5xx classification/backoff helpers live in githubRetry.ts.

export interface FetchGitHubHttpClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: sleep used between rate-limit AND transient-5xx retries. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to honor a `Retry-After` / reset before giving up. */
  maxRateLimitRetries?: number;
  /** How many times to retry a transient 5xx / network error before giving up. */
  maxTransientRetries?: number;
  /** Clock seam (epoch ms) for computing the wait from `X-RateLimit-Reset`. */
  now?: () => number;
}

export class FetchGitHubHttpClient implements GitHubHttpClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly maxTransientRetries: number;
  private readonly now: () => number;

  constructor(opts: FetchGitHubHttpClientOptions = {}) {
    this.apiBaseUrl = opts.apiBaseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => sleepFor(ms));
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
    this.maxTransientRetries = opts.maxTransientRetries ?? DEFAULT_TRANSIENT_RETRIES;
    this.now = opts.now ?? (() => Date.now());
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    let token = input.token;
    let refreshed = false;
    // Separate counters so a 5x burst and a rate-limit burst each have their OWN
    // ceiling — and so a request that hits BOTH a 503 then a 429 is handled within
    // the loop (each path retries up to its own bound). The 401 re-mint is one-shot.
    // §4 fix: the rate-limit path MUST key off its OWN counter, NOT the shared loop
    // index — else transient 503 retries consume the loop index first and a later 429
    // finds `attempt >= maxRateLimitRetries`, so its `Retry-After` is NEVER honored
    // (we'd hammer GitHub past the limit). `rateLimitRetries` is incremented only on
    // the 429/secondary-limit path, exactly mirroring `transientRetries`.
    let transientRetries = 0;
    let rateLimitRetries = 0;
    const retryTransient = input.retryTransient !== false;
    for (;;) {
      let response: GitHubHttpResponse;
      try {
        response = await this.send(input.path, input.method, token, input.body);
      } catch (error) {
        // A TRANSPORT failure (fetch threw: connection reset / DNS / timeout). It is
        // transient by nature (no HTTP status). Retry under the same bounded budget;
        // on exhaustion (or when the caller opted out) re-throw LOUDLY — never a quiet
        // degrade. A non-idempotent write (retryTransient=false) never auto-retries a
        // throw (the request may have applied server-side).
        if (retryTransient && transientRetries < this.maxTransientRetries) {
          await this.sleep(TRANSIENT_BACKOFF_MS[transientRetries] ?? 2_000);
          transientRetries += 1;
          continue;
        }
        throw error;
      }
      // 401 with a token supplier: re-mint once and retry (behavior).
      if (response.status === 401 && input.refreshToken !== undefined && !refreshed) {
        refreshed = true;
        token = await input.refreshToken();
        continue;
      }
      // rate-limited — honor Retry-After / X-RateLimit-Reset / a secondary-limit body,
      // back off, and retry up to the rate-limit ceiling (its OWN counter, independent of
      // any prior transient 503 retries) rather than hammering GitHub. This is checked
      // BEFORE the 403 force-mint so a secondary-rate-limit 403 backs off (re-minting the
      // token would not clear a rate limit, only burn another API call).
      if (response.retryAfterMs !== undefined && rateLimitRetries < this.maxRateLimitRetries) {
        await this.sleep(response.retryAfterMs);
        rateLimitRetries += 1;
        continue;
      }
      // 403 with a token supplier, NOT a rate limit: an installation token can edge-case
      // a 403 (instead of a 401) when revoked/rotated mid-flight. Force-mint ONCE and
      // retry — mirroring the 401 path, sharing the one-shot `refreshed` flag so we never
      // loop. A 403 that PERSISTS after the re-mint (or one already classified rate-limit
      // above) falls through to surface LOUDLY — a genuine permission error is never
      // silently retried forever.
      if (response.status === 403 && input.refreshToken !== undefined && !refreshed) {
        refreshed = true;
        token = await input.refreshToken();
        continue;
      }
      // GitHub-5xx resilience: a transient gateway failure (502/503/504/408) self-heals
      // on an immediate retry. Back off exponentially (500ms→1s→2s) up to the transient
      // ceiling, then surface the raw 5xx response LOUDLY (the caller's `!== 200` guard
      // turns it into a thrown error / an infra-hold) — never a silent success. Opt-out
      // (`retryTransient: false`) lets a non-idempotent write handle its own 5xx.
      if (retryTransient && isTransientStatus(response.status) && transientRetries < this.maxTransientRetries) {
        await this.sleep(TRANSIENT_BACKOFF_MS[transientRetries] ?? 2_000);
        transientRetries += 1;
        continue;
      }
      return response;
    }
  }

  private async send(
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    token: string,
    body: unknown,
  ): Promise<GitHubHttpResponse> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const responseBody = text === "" ? undefined : JSON.parse(text);
    const getHeader = headerGetter(response.headers);
    return {
      status: response.status,
      body: responseBody,
      retryAfterMs: rateLimitBackoffMs(response.status, getHeader, this.now(), responseBody),
      ...(response.status >= 400 && { errorDetail: buildErrorDetail(response.status, responseBody, getHeader) }),
    };
  }
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

export function parseGitHubRepository(repoUrl: string): GitHubRepository {
  const httpsMatch = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(repoUrl);
  if (httpsMatch !== null) {
    return { owner: httpsMatch[1] ?? "", name: httpsMatch[2] ?? "" };
  }
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(repoUrl);
  if (sshMatch !== null) {
    return { owner: sshMatch[1] ?? "", name: sshMatch[2] ?? "" };
  }
  throw new Error(`unsupported GitHub repository URL: ${repoUrl}`);
}

export function parseGitHubPullRequestUrl(prUrl: string): {
  repo: GitHubRepository;
  pullNumber: number;
} {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(prUrl);
  if (match === null) {
    throw new Error(`unsupported GitHub pull request URL: ${prUrl}`);
  }
  return { repo: { owner: match[1] ?? "", name: match[2] ?? "" }, pullNumber: Number(match[3]) };
}

export function githubHttpsRemote(repo: GitHubRepository): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

export function repoPath(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

export function parsePullRequest(value: unknown): GitHubPullRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["number"] !== "number" || typeof object["html_url"] !== "string") {
    throw new TypeError("GitHub PR response missing number or html_url");
  }
  return {
    number: object["number"],
    url: object["html_url"],
    draft: object["draft"] === true,
    baseBranch: parseBaseBranch(object["base"]),
  };
}

export function asPullArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub PR lookup response was not an array");
  }
  return value;
}

function parseBaseBranch(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const ref = (value as Record<string, unknown>)["ref"];
  return typeof ref === "string" ? ref : undefined;
}

function parsePullRequestHead(value: unknown): GitHubPullRequestHead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const head = (value as Record<string, unknown>)["head"];
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    throw new Error("GitHub PR response missing head");
  }
  const object = head as Record<string, unknown>;
  if (typeof object["sha"] !== "string" || object["sha"] === "") {
    throw new Error("GitHub PR response missing head sha");
  }
  return { sha: object["sha"], ref: typeof object["ref"] === "string" ? object["ref"] : undefined };
}
