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

export type RepoCreateOutcome = "created" | "forbidden" | "exists" | "response_lost";

export interface RecordedRepoCreate {
  owner: string;
  name: string;
  private: boolean;
  ownershipMarker?: string;
}

export interface RecordedRepoDelete {
  owner: string;
  name: string;
}

const REPO_CREATE_PATH = /^\/orgs\/([^/]+)\/repos$/u;
const REPO_DELETE_PATH = /^\/repos\/([^/]+)\/([^/]+)$/u;
const REPO_DETAIL_PATH = /^\/repos\/([^/?]+)\/([^/?]+)$/u;
const REPO_COMMITS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/commits\?per_page=2$/u;

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

  constructor(
    private readonly outcome: RepoCreateOutcome = "created",
    private readonly existingRepoIsBare = true,
    private readonly existingOwnershipMarker?: string,
  ) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.method === "GET") {
      const match = REPO_DETAIL_PATH.exec(input.path);
      if (match !== null) {
        const owner = decodeURIComponent(match[1] ?? "");
        const name = decodeURIComponent(match[2] ?? "");
        const created = this.createdRepositories.find((item) => item.owner === owner && item.name === name);
        return {
          status: 200,
          body: {
            full_name: `${owner}/${name}`,
            html_url: `https://github.com/${owner}/${name}`,
            default_branch: "main",
            homepage: created?.ownershipMarker ?? this.existingOwnershipMarker ?? null,
          },
        };
      }
    }
    if (input.method === "GET" && REPO_COMMITS_PATH.test(input.path)) {
      return this.existingRepoIsBare
        ? { status: 409, body: { message: "Git Repository is empty" } }
        : {
            status: 200,
            body: [
              { sha: "compose", commit: { message: "tanren compose: package.json" } },
              { sha: "initial", commit: { message: "Initial commit" } },
            ],
          };
    }
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
    const body = (input.body ?? {}) as { name?: unknown; private?: unknown; homepage?: unknown };
    const name = typeof body.name === "string" ? body.name : "";
    const isPrivate = body.private === true;
    const ownershipMarker = typeof body.homepage === "string" ? body.homepage : undefined;

    if (this.outcome === "forbidden") {
      return { status: 403, body: { message: "Resource not accessible by integration" } };
    }
    if (this.outcome === "exists") {
      return { status: 422, body: { message: "name already exists on this account" } };
    }
    if (this.outcome === "response_lost" && this.createdRepositories.length > 0) {
      return { status: 422, body: { message: "name already exists on this account" } };
    }
    this.createdRepositories.push({
      owner,
      name,
      private: isPrivate,
      ...(ownershipMarker === undefined ? {} : { ownershipMarker }),
    });
    if (this.outcome === "response_lost") throw new Error("injected GitHub create response loss");
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
