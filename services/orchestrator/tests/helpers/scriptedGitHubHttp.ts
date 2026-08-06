import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";

export type ScriptedGitHubResponse = GitHubHttpResponse | readonly GitHubHttpResponse[];

export class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];
  private readonly responses: Map<string, GitHubHttpResponse[]>;

  constructor(responses: Readonly<Record<string, ScriptedGitHubResponse>>) {
    this.responses = new Map(
      Object.entries(responses).map(([path, response]) => [path, Array.isArray(response) ? [...response] : [response]]),
    );
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    const responses = this.responses.get(input.path);
    if (responses === undefined) {
      throw new Error(`unexpected GitHub request path: ${input.path}`);
    }
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected repeated GitHub request path: ${input.path}`);
    }
    return response;
  }
}

export const githubTestPaths = {
  ref: "/repos/o/r/git/ref/heads/main",
  checkRuns: "/repos/o/r/commits/deadbeef/check-runs",
  status: "/repos/o/r/commits/deadbeef/status",
  pull: "/repos/o/r/pulls/7",
  requiredStatusChecks: "/repos/o/r/branches/main/protection/required_status_checks",
  branch: "/repos/o/r/branches/main",
  protection: "/repos/o/r/branches/main/protection",
  rules: (page: number) => `/repos/o/r/rules/branches/main?per_page=100&page=${page}`,
};

export const baseBranchCheckResponses = {
  [githubTestPaths.ref]: { status: 200, body: { object: { sha: "deadbeef" } } },
  [githubTestPaths.checkRuns]: {
    status: 200,
    body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
  },
  [githubTestPaths.status]: { status: 200, body: { statuses: [] } },
};

export function requestedPaths(http: ScriptedGitHubHttp): string[] {
  return http.requests.map((request) => request.path);
}
