// apex-v35 VOLUME guard: the short-TTL single-flight default-branch head cache returns
// cached within the TTL, single-flights concurrent misses, busts on a merge to main, and
// never caches a throw — and `GitHubCodeHost.fetchRef` routes through it while the
// `landAuthorizedIntegration` CAS read stays fresh.

import { describe, expect, it } from "vitest";
import { MainHeadCache, mainHeadCacheKey } from "../src/engine/providers/mainHeadCache.js";
import { GitHubCodeHost } from "../src/engine/providers/githubCodeHost.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";

describe("MainHeadCache (apex-v35 volume guard)", () => {
  it("returns the cached value within the TTL, then re-reads after it expires", async () => {
    let clock = 0;
    const cache = new MainHeadCache({ ttlMs: 5_000, now: () => clock });
    let reads = 0;
    const read = async () => {
      reads += 1;
      return `sha-${reads}`;
    };
    expect(await cache.read("k", read)).toBe("sha-1");
    clock = 4_999;
    // Still within the TTL → served from cache (no re-read).
    expect(await cache.read("k", read)).toBe("sha-1");
    expect(reads).toBe(1);
    clock = 5_001;
    // TTL elapsed → re-read.
    expect(await cache.read("k", read)).toBe("sha-2");
    expect(reads).toBe(2);
  });

  it("single-flights concurrent misses into ONE read", async () => {
    const cache = new MainHeadCache();
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const read = async () => {
      reads += 1;
      await gate;
      return "sha";
    };
    const a = cache.read("k", read);
    const b = cache.read("k", read);
    release();
    expect(await Promise.all([a, b])).toEqual(["sha", "sha"]);
    expect(reads).toBe(1);
  });

  it("busts the cached head on invalidate (a merge moved main)", async () => {
    const cache = new MainHeadCache();
    let reads = 0;
    const read = async () => `sha-${(reads += 1)}`;
    expect(await cache.read("k", read)).toBe("sha-1");
    cache.invalidate("k");
    expect(await cache.read("k", read)).toBe("sha-2");
  });

  it("fences a stale in-flight read so neither reader returns or republishes its SHA", async () => {
    const cache = new MainHeadCache();
    let releaseStale!: () => void;
    let releaseFresh!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const freshGate = new Promise<void>((resolve) => {
      releaseFresh = resolve;
    });
    let staleReads = 0;
    let freshReads = 0;

    const staleReader = cache.read("k", async () => {
      staleReads += 1;
      await staleGate;
      return "stale";
    });
    cache.invalidate("k");
    const postLandReader = cache.read("k", async () => {
      freshReads += 1;
      await freshGate;
      return "fresh";
    });

    // Invalidation makes the post-land reader start a distinct generation, rather than
    // joining the stale flight. When that old flight settles, it joins the fresh one.
    expect([staleReads, freshReads]).toEqual([1, 1]);
    releaseStale();
    releaseFresh();
    await expect(Promise.all([staleReader, postLandReader])).resolves.toEqual(["fresh", "fresh"]);
    expect(await cache.read("k", async () => "unexpected")).toBe("fresh");
  });

  it("does NOT cache a throw (a 403/transient must re-read, never memoize the failure)", async () => {
    const cache = new MainHeadCache();
    let attempts = 0;
    const read = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 403");
      return "sha";
    };
    await expect(cache.read("k", read)).rejects.toThrow(/403/u);
    // The failure was NOT cached → the second read re-runs and succeeds.
    expect(await cache.read("k", read)).toBe("sha");
    expect(attempts).toBe(2);
  });
});

/** A scripted HTTP client that records requested paths. */
class RecordingHttp implements GitHubHttpClient {
  readonly paths: string[] = [];
  constructor(private readonly responder: (path: string) => GitHubHttpResponse | Promise<GitHubHttpResponse>) {}
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.paths.push(input.path);
    return this.responder(input.path);
  }
}

function refResponse(sha: string): GitHubHttpResponse {
  return { status: 200, body: { object: { sha } } };
}

describe("GitHubCodeHost fetchRef caching (apex-v35)", () => {
  const repo = { owner: "o", name: "r" };

  it("collapses repeated default-branch reads, then busts on a land", async () => {
    const http = new RecordingHttp((path) =>
      path.includes("/git/refs/heads/") ? { status: 200, body: { object: { sha: "new" } } } : refResponse("head1"),
    );
    const cache = new MainHeadCache();
    const host = new GitHubCodeHost(http, async () => ({ token: "t" }), cache);

    expect(await host.fetchRef({ repo, remoteBranch: "main" })).toBe("head1");
    expect(await host.fetchRef({ repo, remoteBranch: "main" })).toBe("head1");
    // Two fetchRefs, ONE underlying GitHub ref read (the second hit the cache).
    expect(http.paths.filter((p) => p.startsWith("/repos/o/r/git/ref/heads/")).length).toBe(1);

    // A land to main does its OWN fresh (uncached) CAS read, moves the head, and busts the
    // cache → the next fetchRef then goes to GitHub again. So the ref-read count climbs:
    //   1 (first fetchRef) + 1 (land's fresh CAS read) + 1 (post-bust fetchRef) = 3.
    await host.landAuthorizedIntegration({
      repo,
      intoMain: "main",
      expectedMainSha: "head1",
      authorizedSha: "new",
      idempotencyKey: "intent-mhc",
    });
    await host.fetchRef({ repo, remoteBranch: "main" });
    expect(http.paths.filter((p) => p.startsWith("/repos/o/r/git/ref/heads/")).length).toBe(3);
  });

  it("the landAuthorizedIntegration CAS read is ALWAYS fresh (never served stale from the cache)", async () => {
    // The cache holds `head1`, but main has secretly advanced to `head2`. The CAS read must
    // see `head2` (fresh) and reject the land against the stale expected `head1` — proving
    // the cache never feeds the merge decision a stale base.
    const http = new RecordingHttp((path) =>
      path.includes("/git/refs/heads/") ? { status: 200, body: { object: { sha: "x" } } } : refResponse("head2"),
    );
    const cache = new MainHeadCache();
    // Seed a STALE cached head.
    await cache.read(mainHeadCacheKey("o", "r", "main"), async () => "head1");
    const host = new GitHubCodeHost(http, async () => ({ token: "t" }), cache);

    await expect(
      host.landAuthorizedIntegration({
        repo,
        intoMain: "main",
        expectedMainSha: "head1",
        authorizedSha: "x",
        idempotencyKey: "intent-mhc",
      }),
    ).rejects.toThrow(/stale compare-and-swap/u);
  });

  it("an idempotent retry fences a pre-land flight before reporting the authorized SHA", async () => {
    let mainSha = "head1";
    let refReads = 0;
    let releaseStale!: () => void;
    let staleReadStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStarted = new Promise<void>((resolve) => {
      staleReadStarted = resolve;
    });
    const http = new RecordingHttp(async (path) => {
      if (path.startsWith("/repos/o/r/git/ref/heads/")) {
        refReads += 1;
        if (refReads === 1) {
          staleReadStarted();
          await staleGate;
          return refResponse("head1");
        }
        return refResponse(mainSha);
      }
      if (path.startsWith("/repos/o/r/git/refs/heads/")) {
        mainSha = "head2";
        throw new Error("transport lost after the ref update");
      }
      return refResponse(mainSha);
    });
    const cache = new MainHeadCache();
    const host = new GitHubCodeHost(http, async () => ({ token: "t" }), cache);

    const preLandReader = host.fetchRef({ repo, remoteBranch: "main" });
    await staleStarted;
    await expect(
      host.landAuthorizedIntegration({
        repo,
        intoMain: "main",
        expectedMainSha: "head1",
        authorizedSha: "head2",
        idempotencyKey: "transport-loss",
      }),
    ).rejects.toThrow(/transport lost/u);

    // The retry reads main fresh, observes the already-landed authorized SHA, and must
    // invalidate before it reports success. A following reader cannot join the old flight.
    await expect(
      host.landAuthorizedIntegration({
        repo,
        intoMain: "main",
        expectedMainSha: "head1",
        authorizedSha: "head2",
        idempotencyKey: "transport-loss",
      }),
    ).resolves.toEqual({ mainSha: "head2" });
    const postRetryReader = host.fetchRef({ repo, remoteBranch: "main" });
    releaseStale();

    await expect(Promise.all([preLandReader, postRetryReader])).resolves.toEqual(["head2", "head2"]);
    expect(refReads).toBe(4); // stale flight + failed land + retry + post-retry fresh fetch
    await expect(host.fetchRef({ repo, remoteBranch: "main" })).resolves.toBe("head2");
    expect(refReads).toBe(4);
  });
});
