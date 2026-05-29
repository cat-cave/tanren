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
   * P3-0028 required-check awareness: the branch-protection required status
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
  /** P3-0003: re-mint token + retry once on a 401. */
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
   * P3-0003: optional token-supplier. When provided and the request returns
   * 401 (e.g. an installation token expired/was revoked between mint and use),
   * the client re-mints once via `refreshToken()` and retries the request a
   * single time with the fresh token. Static-token callers omit this.
   */
  refreshToken?: () => Promise<string>;
}

export interface GitHubHttpResponse {
  status: number;
  body: unknown;
  /**
   * P3-0028: rate-limit signal lifted from the response headers. Present when
   * GitHub reports a `Retry-After` (seconds) or an exhausted primary rate-limit
   * window (`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` epoch seconds).
   */
  retryAfterMs?: number;
}

export interface GitHubHttpClient {
  request(input: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

/** P3-0028 rate-limit backoff bounds: never wait less than this, never more. */
export const MIN_RATE_LIMIT_BACKOFF_MS = 1_000;
export const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
/** Default number of times the client re-tries a rate-limited request before surfacing it. */
export const DEFAULT_RATE_LIMIT_RETRIES = 2;

export interface FetchGitHubHttpClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: sleep used between rate-limit retries. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to honor a `Retry-After` / reset before giving up. */
  maxRateLimitRetries?: number;
  /** Clock seam (epoch ms) for computing the wait from `X-RateLimit-Reset`. */
  now?: () => number;
}

export class FetchGitHubHttpClient implements GitHubHttpClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly now: () => number;

  constructor(options: FetchGitHubHttpClientOptions | string = {}, legacyFetch?: typeof fetch) {
    // Back-compat: the prior signature was `(apiBaseUrl, fetchImpl)`.
    const opts: FetchGitHubHttpClientOptions =
      typeof options === "string" ? { apiBaseUrl: options, fetchImpl: legacyFetch } : options;
    this.apiBaseUrl = opts.apiBaseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
    this.now = opts.now ?? (() => Date.now());
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    let token = input.token;
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(input.path, input.method, token, input.body);
      // 401 with a token supplier: re-mint once and retry (P3-0003 behavior).
      if (response.status === 401 && input.refreshToken !== undefined && !refreshed) {
        refreshed = true;
        token = await input.refreshToken();
        continue;
      }
      // P3-0028: rate-limited — honor Retry-After / X-RateLimit-Reset, back off,
      // and retry up to the configured ceiling rather than hammering GitHub.
      if (response.retryAfterMs !== undefined && attempt < this.maxRateLimitRetries) {
        await this.sleep(response.retryAfterMs);
        continue;
      }
      return response;
    }
  }

  private async send(
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    token: string,
    body: unknown
  ): Promise<GitHubHttpResponse> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? undefined : JSON.parse(text),
      retryAfterMs: rateLimitBackoffMs(response.status, headerGetter(response.headers), this.now())
    };
  }
}

type HeaderGetter = (name: string) => string | null;

function headerGetter(headers: Headers | undefined): HeaderGetter {
  return (name) => (headers === undefined ? null : headers.get(name));
}

/**
 * P3-0028: compute how long to wait before retrying a rate-limited GitHub
 * response, or `undefined` if the response is not rate-limited. Honors
 * `Retry-After` (delta seconds) first, then a `403/429` with
 * `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` (epoch seconds). The wait is
 * clamped to [MIN, MAX] so a bogus header can't stall the worker indefinitely.
 */
export function rateLimitBackoffMs(status: number, getHeader: HeaderGetter, nowMs: number): number | undefined {
  if (status !== 403 && status !== 429) {
    return undefined;
  }
  const retryAfter = getHeader("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampBackoff(seconds * 1_000);
    }
  }
  const remaining = getHeader("x-ratelimit-remaining");
  const reset = getHeader("x-ratelimit-reset");
  if (remaining === "0" && reset !== null && reset.trim() !== "") {
    const resetEpoch = Number(reset);
    if (Number.isFinite(resetEpoch)) {
      return clampBackoff(resetEpoch * 1_000 - nowMs);
    }
  }
  return undefined;
}

function clampBackoff(ms: number): number {
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, Math.ceil(ms)));
}

export class GitHubPullRequestService {
  constructor(private readonly http: GitHubHttpClient) {}

  async ensureDraftPullRequest(input: EnsureDraftPullRequestInput): Promise<EnsureDraftPullRequestResult> {
    const existing = await this.findOpenPullRequest(input);
    if (existing !== undefined) {
      return { ...existing, reused: true };
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
        draft: true
      }
    });
    if (created.status === 201) {
      return { ...parsePullRequest(created.body), reused: false };
    }
    if (created.status === 422) {
      const afterRace = await this.findOpenPullRequest(input);
      if (afterRace !== undefined) {
        return { ...afterRace, reused: true };
      }
    }
    throw new Error(`GitHub draft PR creation failed: HTTP ${created.status}`);
  }

  private async findOpenPullRequest(input: EnsureDraftPullRequestInput): Promise<GitHubPullRequest | undefined> {
    const query = new URLSearchParams({ state: "open", head: `${input.repo.owner}:${input.headBranch}`, base: input.baseBranch });
    const response = await this.http.request({
      method: "GET",
      path: repoPath(input.repo, `/pulls?${query.toString()}`),
      token: input.token,
      refreshToken: input.refreshToken
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR lookup failed: HTTP ${response.status}`);
    }
    const pulls = asPullArray(response.body);
    return pulls.map(parsePullRequest).find((pull) => pull.draft && pull.baseBranch === input.baseBranch);
  }
}

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
      refreshToken: input.refreshToken
    });
    if (pull.status !== 200) {
      throw new Error(`GitHub PR fetch failed: HTTP ${pull.status}`);
    }
    const head = parsePullRequestHead(pull.body);
    const baseBranch = parseBaseBranch((pull.body as Record<string, unknown> | undefined)?.["base"]);

    const [checkRuns, statuses] = await Promise.all([
      this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/commits/${encodeURIComponent(head.sha)}/check-runs`),
        token: input.token,
        refreshToken: input.refreshToken
      }),
      this.http.request({
        method: "GET",
        path: repoPath(input.repo, `/commits/${encodeURIComponent(head.sha)}/status`),
        token: input.token,
        refreshToken: input.refreshToken
      })
    ]);
    if (checkRuns.status !== 200) {
      throw new Error(`GitHub check-runs fetch failed: HTTP ${checkRuns.status}`);
    }
    if (statuses.status !== 200) {
      throw new Error(`GitHub commit status fetch failed: HTTP ${statuses.status}`);
    }

    const requiredContexts =
      baseBranch === undefined
        ? undefined
        : await this.fetchRequiredContexts({ ...input, baseBranch });

    return {
      head,
      checkRuns: parseCheckRuns(checkRuns.body),
      statuses: parseCommitStatuses(statuses.body),
      requiredContexts
    };
  }

  /**
   * P3-0028: read the branch-protection required status check contexts for a
   * base branch. Returns `undefined` when the branch is unprotected (404) or
   * the protection config can't be read — callers treat that as "no required
   * gating" and fall back to the all-observed-green rule.
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
      refreshToken: input.refreshToken
    });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      return undefined;
    }
    return parseRequiredContexts(response.body);
  }
}

function parseRequiredContexts(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  // The modern `checks` array carries per-check `context`; `contexts` is the
  // legacy string list. Prefer `checks` and fall back to `contexts`.
  const checks = object["checks"];
  if (Array.isArray(checks)) {
    const names = checks
      .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["context"] : undefined))
      .filter((name): name is string => typeof name === "string");
    if (names.length > 0) {
      return names;
    }
  }
  const contexts = object["contexts"];
  if (Array.isArray(contexts)) {
    return contexts.filter((name): name is string => typeof name === "string");
  }
  return [];
}

export function parseGitHubRepository(repoUrl: string): GitHubRepository {
  const httpsMatch = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (httpsMatch !== null) {
    return { owner: httpsMatch[1] ?? "", name: httpsMatch[2] ?? "" };
  }
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(repoUrl);
  if (sshMatch !== null) {
    return { owner: sshMatch[1] ?? "", name: sshMatch[2] ?? "" };
  }
  throw new Error(`unsupported GitHub repository URL: ${repoUrl}`);
}

export function parseGitHubPullRequestUrl(prUrl: string): { repo: GitHubRepository; pullNumber: number } {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)\/?$/.exec(prUrl);
  if (match === null) {
    throw new Error(`unsupported GitHub pull request URL: ${prUrl}`);
  }
  return { repo: { owner: match[1] ?? "", name: match[2] ?? "" }, pullNumber: Number(match[3]) };
}

export function githubHttpsRemote(repo: GitHubRepository): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

function repoPath(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function parsePullRequest(value: unknown): GitHubPullRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["number"] !== "number" || typeof object["html_url"] !== "string") {
    throw new Error("GitHub PR response missing number or html_url");
  }
  return { number: object["number"], url: object["html_url"], draft: object["draft"] === true, baseBranch: parseBaseBranch(object["base"]) };
}

function asPullArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub PR lookup response was not an array");
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

function parseCheckRuns(value: unknown): GitHubCheckRun[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub check-runs response was not an object");
  }
  const checkRuns = (value as Record<string, unknown>)["check_runs"];
  if (!Array.isArray(checkRuns)) {
    throw new Error("GitHub check-runs response missing check_runs");
  }
  return checkRuns.map(parseCheckRun);
}

function parseCheckRun(value: unknown): GitHubCheckRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub check run was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["name"] !== "string" || typeof object["status"] !== "string") {
    throw new Error("GitHub check run missing name or status");
  }
  return {
    name: object["name"],
    status: object["status"],
    conclusion: typeof object["conclusion"] === "string" ? object["conclusion"] : undefined,
    url: typeof object["html_url"] === "string" ? object["html_url"] : undefined
  };
}

function parseCommitStatuses(value: unknown): GitHubCommitStatus[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub commit status response was not an object");
  }
  const statuses = (value as Record<string, unknown>)["statuses"];
  if (!Array.isArray(statuses)) {
    throw new Error("GitHub commit status response missing statuses");
  }
  return statuses.map(parseCommitStatus);
}

function parseCommitStatus(value: unknown): GitHubCommitStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub commit status was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["context"] !== "string" || typeof object["state"] !== "string") {
    throw new Error("GitHub commit status missing context or state");
  }
  return {
    context: object["context"],
    state: object["state"],
    url: typeof object["target_url"] === "string" ? object["target_url"] : undefined
  };
}
