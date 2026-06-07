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
import { GitHubCodeHost, LandCasRejectedError } from "../../src/engine/providers/githubCodeHost.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import { describeCodeHostConformance } from "./codeHostConformance.js";

const TOKEN = "ghs_conformance_fake_token";

interface RepoState {
  defaultBranch: string;
  /** branch -> head sha */
  branches: Map<string, string>;
  /**
   * sha -> the head sha it was BUILT ON (its parent). A `force: false` (ff-only)
   * update to `sha` is a fast-forward iff the ref currently points at this base —
   * the same constraint GitHub enforces. Bare/unregistered shas default to a
   * fast-forward (the happy land path of the frozen suite).
   */
  ffBase: Map<string, string>;
}

/**
 * A stateful fake GitHub transport answering the exact endpoints `GitHubCodeHost`
 * calls: the git-refs read/create/update, the repo read (default branch). It
 * MODELS FAST-FORWARD-ONLY semantics (`force: false`) so it can prove the land's
 * compare-and-swap is real, not message-text theatre. Only the fields the impl
 * reads are populated. Token never inspected (it rides the auth header in the real
 * client; here it is simply ignored).
 */
class StatefulGitHubHttp implements GitHubHttpClient {
  private readonly repos = new Map<string, RepoState>();
  /**
   * A one-shot race injector: run (and cleared) JUST BEFORE the next PATCH is
   * applied, so a test can move main AFTER the land's read-check passed but BEFORE
   * its ff-only write — exactly the read→write window the CAS must close.
   */
  private beforeNextPatch: (() => void) | undefined;

  seedRepo(owner: string, name: string, defaultBranch: string, initialSha: string): void {
    this.repos.set(`${owner}/${name}`, {
      defaultBranch,
      branches: new Map([[defaultBranch, initialSha]]),
      ffBase: new Map(),
    });
  }

  /** Record that `sha` was built on `base` (so a ff-only update to it requires main == base). */
  setFastForwardBase(owner: string, name: string, sha: string, base: string): void {
    this.repos.get(`${owner}/${name}`)?.ffBase.set(sha, base);
  }

  /** Inject a one-shot mutation that fires right before the next PATCH lands. */
  injectRaceBeforeNextPatch(fn: () => void): void {
    this.beforeNextPatch = fn;
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
      // Fire the one-shot race injector FIRST: this is the read→write window the
      // land's ff-only guard must close (main may move here, after the read-check).
      const race = this.beforeNextPatch;
      this.beforeNextPatch = undefined;
      race?.();
      // Re-resolve the repo state AFTER the race (the injector may have reseeded it),
      // so the write observes the post-race head — exactly as GitHub would.
      const postRace = this.repos.get(`${owner}/${name}`);
      if (postRace === undefined) {
        return { status: 404, body: { message: "no such repo" } };
      }

      const branch = decodeURIComponent(updateMatch[1] ?? "");
      const body = input.body as { sha?: unknown; force?: unknown };
      const sha = typeof body.sha === "string" ? body.sha : "";
      const force = body.force === true;
      const current = postRace.branches.get(branch);
      if (!force) {
        // FAST-FORWARD-ONLY (`force: false`, the land path). GitHub accepts the
        // update ONLY if it advances the ref — i.e. the ref still points at the base
        // `sha` was built on. A vanished ref, or a ref that moved off that base
        // (a competing update raced ahead), is a non-fast-forward → 422.
        if (current === undefined) {
          return { status: 422, body: { message: "Reference does not exist" } };
        }
        const base = postRace.ffBase.get(sha);
        if (base !== undefined && current !== base) {
          return { status: 422, body: { message: "Update is not a fast forward" } };
        }
      }
      postRace.branches.set(branch, sha);
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha } } };
    }

    return { status: 404, body: { message: "unhandled endpoint" } };
  }
}

const REPO = { owner: "owner", name: "repo" } as const;

describe("GitHubCodeHost over a fake GitHub transport", () => {
  it("landAuthorizedRef rejects a stale expectation at the READ-check (typed)", async () => {
    const http = new StatefulGitHubHttp();
    // main already moved past the expectation (it points at sha-main-1, not sha-main-0).
    http.seedRepo("owner", "repo", "main", "sha-main-1");
    const host = new GitHubCodeHost(http, async () => ({ token: TOKEN }));
    const err = await host
      .landAuthorizedRef({
        repo: REPO,
        intoMain: "main",
        authorizedSha: "sha-authorized-1",
        expectedMainSha: "sha-main-0",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LandCasRejectedError);
  });

  it("landAuthorizedRef rejects a race that moves main AFTER the read-check but BEFORE the ff-only write", async () => {
    const http = new StatefulGitHubHttp();
    http.seedRepo("owner", "repo", "main", "sha-main-0");
    // The authorized commit was built on sha-main-0 (its ff base). It is a
    // fast-forward of main ONLY while main still points at sha-main-0.
    http.setFastForwardBase("owner", "repo", "sha-authorized-1", "sha-main-0");
    // Inject a competing land that advances main to sha-rival-1 in the read→write
    // window — so the read-check passes (main is still sha-main-0 when read) but the
    // ff-only PATCH must be REJECTED (main is now sha-rival-1, not the ff base).
    http.injectRaceBeforeNextPatch(() => {
      http.seedRepo("owner", "repo", "main", "sha-rival-1");
      http.setFastForwardBase("owner", "repo", "sha-authorized-1", "sha-main-0");
    });
    const host = new GitHubCodeHost(http, async () => ({ token: TOKEN }));

    const err = await host
      .landAuthorizedRef({
        repo: REPO,
        intoMain: "main",
        authorizedSha: "sha-authorized-1",
        expectedMainSha: "sha-main-0",
      })
      .catch((e: unknown) => e);

    // The ff-only WRITE (not the read) is what closes the race → typed rejection.
    expect(err).toBeInstanceOf(LandCasRejectedError);
    // main is NOT clobbered: it still carries the rival commit, never the authorized one.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-rival-1");
  });

  it("pushRef REFUSES to force-update the default branch on a non-fast-forward (main is landAuthorizedRef-only)", async () => {
    const http = new StatefulGitHubHttp();
    http.seedRepo("owner", "repo", "main", "sha-main-0");
    // sha-evil-1 is built on a DIFFERENT base (sha-unrelated) — i.e. it is NOT a
    // fast-forward of main. Only a force could push it; pushRef must refuse.
    http.setFastForwardBase("owner", "repo", "sha-evil-1", "sha-unrelated");
    const host = new GitHubCodeHost(http, async () => ({ token: TOKEN }));
    await expect(
      host.pushRef({ repo: REPO, localRef: "refs/heads/main", remoteBranch: "main", sha: "sha-evil-1" }),
    ).rejects.toThrow(/refused to force-update the default branch/iu);
    // main is untouched — never force-clobbered.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main-0");
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
