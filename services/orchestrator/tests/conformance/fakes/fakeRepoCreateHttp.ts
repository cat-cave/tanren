// A TEST-FIXTURE `GitHubHttpClient` that backs the greenfield/template repo-create
// path (`POST /orgs/:owner/repos`) so the route tests can exercise the REAL
// `GitHubCodeHost.createRepo` seam (decomposition PR-3) without a network/transport.
// It records each create (owner/name/private) so a suite can assert exactly what was
// created — the same observation `InMemoryVcsProvider.createdRepositories` gave the
// pre-decomposition tests — and supports the typed outcomes the contract pins:
// success (201), forbidden (403), already-taken (422). Fixtures live HERE, never src/.

import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../../src/engine/providers/github.js";

export type RepoCreateOutcome = "created" | "forbidden" | "exists";

export interface RecordedRepoCreate {
  owner: string;
  name: string;
  private: boolean;
}

const REPO_CREATE_PATH = /^\/orgs\/([^/]+)\/repos$/u;

/**
 * The repo-create transport fake. Defaults to a clean `created` outcome; set
 * `outcome` to surface the typed forbidden/already-exists branches. Any non
 * repo-create request is a LOUD throw — these route tests only drive repo-create,
 * so an unexpected call is a test-wiring bug, never a silent stand-in.
 */
export class FakeRepoCreateHttp implements GitHubHttpClient {
  /** Every recorded greenfield repo create (assertable like `createdRepositories`). */
  readonly createdRepositories: RecordedRepoCreate[] = [];

  constructor(private readonly outcome: RepoCreateOutcome = "created") {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const match = REPO_CREATE_PATH.exec(input.path);
    if (input.method !== "POST" || match === null) {
      throw new Error(`FakeRepoCreateHttp: unexpected ${input.method} ${input.path} (only repo-create is faked)`);
    }
    const owner = decodeURIComponent(match[1] ?? "");
    const body = (input.body ?? {}) as { name?: unknown; private?: unknown };
    const name = typeof body.name === "string" ? body.name : "";
    const isPrivate = body.private === true;

    if (this.outcome === "forbidden") {
      return { status: 403, body: { message: "Resource not accessible by integration" } };
    }
    if (this.outcome === "exists") {
      return { status: 422, body: { message: "name already exists on this account" } };
    }
    this.createdRepositories.push({ owner, name, private: isPrivate });
    return {
      status: 201,
      body: {
        full_name: `${owner}/${name}`,
        html_url: `https://github.com/${owner}/${name}`,
        default_branch: "main",
      },
    };
  }
}
