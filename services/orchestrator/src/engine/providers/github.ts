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

export interface EnsureDraftPullRequestInput {
  repo: GitHubRepository;
  token: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
}

export interface EnsureDraftPullRequestResult extends GitHubPullRequest {
  reused: boolean;
}

export interface GitHubHttpRequest {
  method: "GET" | "POST";
  path: string;
  token: string;
  body?: unknown;
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
    const response = await this.fetchImpl(`${this.apiBaseUrl}${input.path}`, {
      method: input.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
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
      token: input.token
    });
    if (response.status !== 200) {
      throw new Error(`GitHub PR lookup failed: HTTP ${response.status}`);
    }
    const pulls = asPullArray(response.body);
    return pulls.map(parsePullRequest).find((pull) => pull.draft && pull.baseBranch === input.baseBranch);
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
