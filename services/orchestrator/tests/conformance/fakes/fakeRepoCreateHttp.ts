// A TEST-FIXTURE `GitHubHttpClient` that backs the greenfield/template repo-create
// path (`POST /orgs/:owner/repos`) + the derive-rollback repo-delete path
// (`DELETE /repos/:owner/:name`) so the route tests exercise the REAL
// `GitHubCodeHost.createRepo`/`deleteRepo` seams (decomposition PR-3 + task #78)
// without a network/transport. It records each create (owner/name/private) AND
// each delete (owner/name) so a suite can assert exactly what was created + what
// was rolled back — the same observation `InMemoryVcsProvider.createdRepositories`
// gave the pre-decomposition tests — and supports the typed outcomes the contract
// pins: success (201), forbidden (403), already-taken (422). Fixtures live HERE,
// never src/.

import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../../src/engine/providers/github.js";

export type RepoCreateOutcome = "created" | "forbidden" | "exists";

export interface RecordedRepoCreate {
  owner: string;
  name: string;
  private: boolean;
}

export interface RecordedRepoDelete {
  owner: string;
  name: string;
}

const REPO_CREATE_PATH = /^\/orgs\/([^/]+)\/repos$/u;
const REPO_DELETE_PATH = /^\/repos\/([^/]+)\/([^/]+)$/u;

/**
 * The repo-create transport fake. Defaults to a clean `created` outcome; set
 * `outcome` to surface the typed forbidden/already-exists branches. Also serves
 * `DELETE /repos/:owner/:name` so the derive's transactional rollback (task #78)
 * exercises the live `CodeHost.deleteRepo` seam under tests. Any non
 * repo-create/repo-delete request is a LOUD throw — these route tests only drive
 * repo lifecycle, so an unexpected call is a test-wiring bug, never a silent
 * stand-in.
 */
export class FakeRepoCreateHttp implements GitHubHttpClient {
  /** Every recorded greenfield repo create (assertable like `createdRepositories`). */
  readonly createdRepositories: RecordedRepoCreate[] = [];
  /** Every recorded repo DELETE (the derive transactional rollback compensations). */
  readonly deletedRepositories: RecordedRepoDelete[] = [];

  constructor(private readonly outcome: RepoCreateOutcome = "created") {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.method === "DELETE") {
      const match = REPO_DELETE_PATH.exec(input.path);
      if (match === null) {
        throw new Error(
          `FakeRepoCreateHttp: unexpected ${input.method} ${input.path} (only repo-delete is DELETE-faked)`,
        );
      }
      const owner = decodeURIComponent(match[1] ?? "");
      const name = decodeURIComponent(match[2] ?? "");
      // If the repo was never created in this fixture, treat it as a 404 (the
      // rollback semantic: "ensure this is gone" is satisfied either way). When
      // it WAS created, record the delete + return 204 No Content.
      const existed = this.createdRepositories.some((r) => r.owner === owner && r.name === name);
      if (!existed) {
        return { status: 404, body: { message: "Not Found" } };
      }
      this.deletedRepositories.push({ owner, name });
      return { status: 204, body: null };
    }
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
