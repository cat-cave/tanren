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
  method: "GET" | "POST";
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
}

export interface GitHubHttpClient {
  request(input: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

export class FetchGitHubHttpClient implements GitHubHttpClient {
  constructor(private readonly apiBaseUrl = "https://api.github.com", private readonly fetchImpl: typeof fetch = fetch) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const first = await this.send(input.path, input.method, input.token, input.body);
    if (first.status !== 401 || input.refreshToken === undefined) {
      return first;
    }
    const freshToken = await input.refreshToken();
    return this.send(input.path, input.method, freshToken, input.body);
  }

  private async send(path: string, method: "GET" | "POST", token: string, body: unknown): Promise<GitHubHttpResponse> {
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
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  }
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

    return {
      head,
      checkRuns: parseCheckRuns(checkRuns.body),
      statuses: parseCommitStatuses(statuses.body)
    };
  }
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
  if (typeof object.number !== "number" || typeof object.html_url !== "string") {
    throw new Error("GitHub PR response missing number or html_url");
  }
  return { number: object.number, url: object.html_url, draft: object.draft === true, baseBranch: parseBaseBranch(object.base) };
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
  const ref = (value as Record<string, unknown>).ref;
  return typeof ref === "string" ? ref : undefined;
}

function parsePullRequestHead(value: unknown): GitHubPullRequestHead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const head = (value as Record<string, unknown>).head;
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    throw new Error("GitHub PR response missing head");
  }
  const object = head as Record<string, unknown>;
  if (typeof object.sha !== "string" || object.sha === "") {
    throw new Error("GitHub PR response missing head sha");
  }
  return { sha: object.sha, ref: typeof object.ref === "string" ? object.ref : undefined };
}

function parseCheckRuns(value: unknown): GitHubCheckRun[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub check-runs response was not an object");
  }
  const checkRuns = (value as Record<string, unknown>).check_runs;
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
  if (typeof object.name !== "string" || typeof object.status !== "string") {
    throw new Error("GitHub check run missing name or status");
  }
  return {
    name: object.name,
    status: object.status,
    conclusion: typeof object.conclusion === "string" ? object.conclusion : undefined,
    url: typeof object.html_url === "string" ? object.html_url : undefined
  };
}

function parseCommitStatuses(value: unknown): GitHubCommitStatus[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub commit status response was not an object");
  }
  const statuses = (value as Record<string, unknown>).statuses;
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
  if (typeof object.context !== "string" || typeof object.state !== "string") {
    throw new Error("GitHub commit status missing context or state");
  }
  return {
    context: object.context,
    state: object.state,
    url: typeof object.target_url === "string" ? object.target_url : undefined
  };
}
