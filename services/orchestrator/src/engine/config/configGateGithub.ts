// P3-0017: the real GitHub adapter behind the audit-gate `ConfigGateGitHub`
// port. Wraps the shared `GitHubHttpClient` (P3-0028) so the gate can:
//   1. resolve the base branch's head SHA,
//   2. create the head branch (idempotently),
//   3. commit `tanren.yaml` to that branch via the contents API,
//   4. open (or reuse) the PR via `GitHubPullRequestService`.
//
// The HTTP client + token are injected, so the orchestrator wires it from the
// P3-0003 App-token resolver and tests use the in-memory fake instead.

import {
  GitHubPullRequestService,
  parseGitHubRepository,
  type GitHubHttpClient,
  type GitHubRepository,
} from "../providers/github.js";
import type { ConfigGateGitHub, GateConfigPullRequest } from "./tanrenConfigGate.js";

function repoApi(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

export interface FetchConfigGateGitHubInput {
  http: GitHubHttpClient;
  token: string;
  refreshToken?: () => Promise<string>;
}

export class FetchConfigGateGitHub implements ConfigGateGitHub {
  private readonly prService: GitHubPullRequestService;

  constructor(private readonly deps: FetchConfigGateGitHubInput) {
    this.prService = new GitHubPullRequestService(deps.http);
  }

  async openConfigPr(input: {
    repo: string;
    baseBranch: string;
    headBranch: string;
    configFile: string;
    yaml: string;
    title: string;
    body: string;
  }): Promise<GateConfigPullRequest> {
    const repo = parseGitHubRepository(`https://github.com/${input.repo}`);
    await this.ensureBranch(repo, input.baseBranch, input.headBranch);
    await this.commitFile(repo, input.headBranch, input.configFile, input.yaml, input.title);
    const pr = await this.prService.ensureDraftPullRequest({
      repo,
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    });
    return { number: pr.number, url: pr.url, branch: input.headBranch };
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
    // 201 created, 422 already-exists → both fine for an idempotent open.
    if (create.status !== 201 && create.status !== 422) {
      throw new Error(`could not create branch ${headBranch}: HTTP ${create.status}`);
    }
  }

  /** PUT the YAML to `configFile` on `headBranch`, carrying the prior blob sha. */
  private async commitFile(
    repo: GitHubRepository,
    headBranch: string,
    configFile: string,
    yaml: string,
    message: string,
  ): Promise<void> {
    const existing = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/contents/${encodeRepoPath(configFile)}?ref=${encodeURIComponent(headBranch)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
    });
    const sha = existing.status === 200 ? contentSha(existing.body) : undefined;
    const put = await this.deps.http.request({
      method: "PUT",
      path: repoApi(repo, `/contents/${encodeRepoPath(configFile)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      body: {
        message,
        branch: headBranch,
        content: Buffer.from(yaml, "utf8").toString("base64"),
        ...(sha === undefined ? {} : { sha }),
      },
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`could not commit ${configFile}: HTTP ${put.status}`);
    }
  }
}

function baseRefSha(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const object = body as Record<string, unknown>;
    const objectRef = object["object"];
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
