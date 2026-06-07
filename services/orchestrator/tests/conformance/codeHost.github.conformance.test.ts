// Wave-1 driver: runs the FROZEN `codeHostConformance` suite
// (tanren-owns-the-engine.md §6) against the PRODUCTION `GitHubCodeHost`, over a
// FAKE GitHub HTTP transport so it is hermetic in CI (no real GitHub, no network).
//
// The fake (`StatefulGitHubHttp`) is a TEST FIXTURE (it lives HERE, under tests/,
// never in src/). It mirrors how the VcsProvider conformance test fakes the API —
// a `GitHubHttpClient` impl routing on method + path — but is STATEFUL: it backs
// each repo's branch refs in a mutable map so the suite's any-order push / fetch /
// land calls observe each other (a pushed ref is fetchable; a CAS land advances
// the same ref the next fetch reads). This pins the real impl's git-refs wiring +
// its compare-and-swap land against the contract, without a database or network.
//
// Asserts (via the shared suite): push/fetch round-trip, readDefaultBranch, a CAS
// land advances main, and a stale-CAS land is REJECTED.

import { describe, expect, it } from "vitest";
import { GitHubCodeHost } from "../../src/engine/providers/githubCodeHost.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import { describeCodeHostConformance } from "./codeHostConformance.js";

const TOKEN = "ghs_conformance_fake_token";

interface RepoState {
  defaultBranch: string;
  /** branch -> head sha */
  branches: Map<string, string>;
}

/**
 * A stateful fake GitHub transport answering the exact endpoints `GitHubCodeHost`
 * calls: the git-refs read/create/update, the repo read (default branch). Only the
 * fields the impl reads are populated. Token never inspected (it rides the auth
 * header in the real client; here it is simply ignored).
 */
class StatefulGitHubHttp implements GitHubHttpClient {
  private readonly repos = new Map<string, RepoState>();

  seedRepo(owner: string, name: string, defaultBranch: string, initialSha: string): void {
    this.repos.set(`${owner}/${name}`, {
      defaultBranch,
      branches: new Map([[defaultBranch, initialSha]]),
    });
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const path = input.path.split("?")[0] ?? input.path;
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/u.exec(path);
    if (repoMatch === null) {
      return { status: 404, body: { message: "no route" } };
    }
    const owner = decodeURIComponent(repoMatch[1] ?? "");
    const name = decodeURIComponent(repoMatch[2] ?? "");
    const suffix = repoMatch[3] ?? "";
    const repo = this.repos.get(`${owner}/${name}`);
    if (repo === undefined) {
      return { status: 404, body: { message: "no such repo" } };
    }

    // readDefaultBranch: GET /repos/:o/:r
    if (input.method === "GET" && suffix === "") {
      return { status: 200, body: { default_branch: repo.defaultBranch } };
    }

    // fetchRef / land-read: GET /git/ref/heads/:branch
    const readMatch = /^\/git\/ref\/heads\/(.+)$/u.exec(suffix);
    if (input.method === "GET" && readMatch !== null) {
      const branch = decodeURIComponent(readMatch[1] ?? "");
      const sha = repo.branches.get(branch);
      if (sha === undefined) {
        return { status: 404, body: { message: "no such ref" } };
      }
      return { status: 200, body: { object: { sha } } };
    }

    // pushRef create: POST /git/refs  { ref: "refs/heads/:b", sha }
    if (input.method === "POST" && suffix === "/git/refs") {
      const body = input.body as { ref?: unknown; sha?: unknown };
      const ref = typeof body.ref === "string" ? body.ref : "";
      const sha = typeof body.sha === "string" ? body.sha : "";
      const branch = ref.replace(/^refs\/heads\//u, "");
      if (repo.branches.has(branch)) {
        return { status: 422, body: { message: "Reference already exists" } };
      }
      repo.branches.set(branch, sha);
      return { status: 201, body: { ref, object: { sha } } };
    }

    // pushRef force-update OR landAuthorizedRef swap: PATCH /git/refs/heads/:branch
    const updateMatch = /^\/git\/refs\/heads\/(.+)$/u.exec(suffix);
    if (input.method === "PATCH" && updateMatch !== null) {
      const branch = decodeURIComponent(updateMatch[1] ?? "");
      const body = input.body as { sha?: unknown; force?: unknown };
      const sha = typeof body.sha === "string" ? body.sha : "";
      const force = body.force === true;
      const current = repo.branches.get(branch);
      // Fast-forward-only (`force: false`, the land path): GitHub rejects (422) a
      // non-existent ref. The CAS guard already read-checked the expected sha, so
      // here we only model the "ref vanished mid-land" race → 422.
      if (!force && current === undefined) {
        return { status: 422, body: { message: "Reference does not exist" } };
      }
      repo.branches.set(branch, sha);
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha } } };
    }

    return { status: 404, body: { message: "unhandled endpoint" } };
  }
}

describe("GitHubCodeHost over a fake GitHub transport", () => {
  it("landAuthorizedRef rejection is LOUD + typed (stale compare-and-swap)", async () => {
    const http = new StatefulGitHubHttp();
    http.seedRepo("owner", "repo", "main", "sha-main-0");
    // Advance main out-of-band so the expected sha is stale.
    http.seedRepo("owner", "repo", "main", "sha-main-1");
    const host = new GitHubCodeHost(http, async () => ({ token: TOKEN }));
    await expect(
      host.landAuthorizedRef({
        repo: { owner: "owner", name: "repo" },
        intoMain: "main",
        authorizedSha: "sha-authorized-1",
        expectedMainSha: "sha-main-0",
      }),
    ).rejects.toThrow(/stale compare-and-swap/iu);
  });
});

// The FROZEN behavior spec (push/fetch round-trip, readDefaultBranch, CAS land
// advances main, stale-CAS land rejected) — each `make()` gets a FRESH transport,
// and `seed` stands the repo up in the fake's terms.
describeCodeHostConformance(
  "GitHubCodeHost (fake GitHub transport)",
  (() => {
    // One transport per `make()` so cases never share ref state. The harness's
    // `make()` is arg-free, so we close over the most-recent transport here and seed
    // it through the same closure.
    let transport = new StatefulGitHubHttp();
    return {
      make: () => {
        transport = new StatefulGitHubHttp();
        return new GitHubCodeHost(transport, async () => ({ token: TOKEN }));
      },
      seed: (_host, repo, defaultBranch, initialSha) => {
        transport.seedRepo(repo.owner, repo.name, defaultBranch, initialSha);
      },
    };
  })(),
);
