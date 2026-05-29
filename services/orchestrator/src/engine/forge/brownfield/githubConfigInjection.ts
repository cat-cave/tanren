// P3-0016: the real GitHub adapter behind the `ConfigInjectionGitHub` port.
// Wraps the shared `GitHubHttpClient` (P3-0028) to: read the base branch head
// SHA, create the head branch (idempotently), PUT each kept file via the
// contents API, then open (or reuse) the PR via `GitHubPullRequestService`.
// Modeled on the P3-0017 `FetchConfigGateGitHub` adapter — same branch/commit/
// PR shape, generalized to commit MULTIPLE files in one PR.
//
// The HTTP client + token are injected, so the orchestrator wires it from the
// P3-0003 App-token resolver and tests use the in-memory fake port instead.

import {
  GitHubPullRequestService,
  parseGitHubRepository,
  type GitHubHttpClient,
  type GitHubRepository,
} from "../../providers/github.js";
import type { ConfigInjectionGitHub, InjectedConfigPullRequest } from "./configInjection.js";

function repoApi(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

export interface FetchConfigInjectionGitHubInput {
  http: GitHubHttpClient;
  token: string;
  refreshToken?: () => Promise<string>;
}

export class FetchConfigInjectionGitHub implements ConfigInjectionGitHub {
  private readonly prService: GitHubPullRequestService;

  constructor(private readonly deps: FetchConfigInjectionGitHubInput) {
    this.prService = new GitHubPullRequestService(deps.http);
  }

  async openConfigInjectionPr(input: {
    repoUrl: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
    files: ReadonlyArray<{ path: string; content: string }>;
  }): Promise<InjectedConfigPullRequest> {
    const repo = parseGitHubRepository(input.repoUrl);
    await this.ensureBranch(repo, input.baseBranch, input.headBranch);
    for (const file of input.files) {
      await this.commitFile(repo, input.headBranch, file.path, file.content, input.title);
    }
    const pr = await this.prService.ensureDraftPullRequest({
      repo,
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    });
    return {
      number: pr.number,
      url: pr.url,
      branch: input.headBranch,
      filesCommitted: input.files.map((f) => f.path),
    };
  }

  /** Create `headBranch` at `baseBranch`'s head SHA; tolerate an existing ref. */
  private async ensureBranch(repo: GitHubRepository, baseBranch: string, headBranch: string): Promise<void> {
    const ref = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/git/ref/${encodeRepoPath(`heads/${baseBranch}`)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
    });
    if (ref.status !== 200) {
      throw new Error(`could not read base branch ${baseBranch}: HTTP ${ref.status}`);
    }
    const sha = baseRefSha(ref.body);
    const create = await this.deps.http.request({
      method: "POST",
      path: repoApi(repo, "/git/refs"),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      body: { ref: `refs/heads/${headBranch}`, sha },
    });
    if (create.status !== 201 && create.status !== 422) {
      throw new Error(`could not create branch ${headBranch}: HTTP ${create.status}`);
    }
  }

  /** PUT `content` to `path` on `headBranch`, carrying the prior blob sha if any. */
  private async commitFile(
    repo: GitHubRepository,
    headBranch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    const existing = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(headBranch)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
    });
    const sha = existing.status === 200 ? contentSha(existing.body) : undefined;
    const put = await this.deps.http.request({
      method: "PUT",
      path: repoApi(repo, `/contents/${encodeRepoPath(path)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      body: {
        message: `${message}: ${path}`,
        branch: headBranch,
        content: Buffer.from(content, "utf8").toString("base64"),
        ...(sha !== undefined ? { sha } : {}),
      },
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`could not commit ${path}: HTTP ${put.status}`);
    }
  }
}

function baseRefSha(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const objectRef = (body as Record<string, unknown>)["object"];
    if (typeof objectRef === "object" && objectRef !== null) {
      const sha = (objectRef as Record<string, unknown>)["sha"];
      if (typeof sha === "string" && sha !== "") return sha;
    }
  }
  throw new Error("GitHub ref response missing object.sha");
}

function contentSha(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const sha = (body as Record<string, unknown>)["sha"];
    if (typeof sha === "string" && sha !== "") return sha;
  }
  return undefined;
}
