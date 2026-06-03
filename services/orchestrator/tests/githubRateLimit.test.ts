// P3-0028: the GitHub HTTP client honors rate-limit signals (Retry-After /
// X-RateLimit-Reset) with bounded backoff instead of hammering, and the status
// service reads branch-protection required contexts.

import { describe, expect, it } from "vitest";
import {
  FetchGitHubHttpClient,
  GitHubStatusService,
  type GitHubHttpClient,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "../src/engine/providers/github.js";
import {
  MAX_RATE_LIMIT_BACKOFF_MS,
  MIN_RATE_LIMIT_BACKOFF_MS,
  rateLimitBackoffMs,
} from "../src/engine/providers/githubRetry.js";

function headers(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(map)) {
    h.set(key, value);
  }
  return h;
}

const get =
  (map: Record<string, string>) =>
  (name: string): string | null =>
    map[name] ?? null;

describe("github rate-limit backoff (P3-0028)", () => {
  it("derives a clamped wait from Retry-After and X-RateLimit-Reset", () => {
    const now = 1_000_000;
    // Retry-After (seconds) wins, clamped to the ceiling.
    expect(rateLimitBackoffMs(429, get({ "retry-after": "5" }), now)).toBe(5_000);
    expect(rateLimitBackoffMs(403, get({ "retry-after": "999999" }), now)).toBe(MAX_RATE_LIMIT_BACKOFF_MS);
    // Reset epoch used when remaining is exhausted; floored to the minimum.
    expect(
      rateLimitBackoffMs(403, get({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1_000) }), now),
    ).toBe(MIN_RATE_LIMIT_BACKOFF_MS);
    // Not rate-limited → undefined.
    expect(rateLimitBackoffMs(200, get({}), now)).toBeUndefined();
    expect(rateLimitBackoffMs(403, get({}), now)).toBeUndefined();
  });

  it("waits then retries a rate-limited request rather than failing immediately", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return new Response("", { status: 429, headers: headers({ "retry-after": "3" }) });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({
      fetchImpl,
      sleep: async (ms) => void slept.push(ms),
    });
    const response = await client.request({ method: "GET", path: "/rate", token: "t" });

    expect(slept).toEqual([3_000]);
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("gives up after the retry ceiling instead of looping forever", async () => {
    const slept: number[] = [];
    const fetchImpl = (async () =>
      new Response("", {
        status: 429,
        headers: headers({ "retry-after": "2" }),
      })) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({
      fetchImpl,
      sleep: async (ms) => void slept.push(ms),
      maxRateLimitRetries: 2,
    });

    const response = await client.request({ method: "GET", path: "/rate", token: "t" });
    expect(slept).toEqual([2_000, 2_000]);
    expect(response.status).toBe(429);
  });
});

describe("github required-context awareness (P3-0028)", () => {
  it("reads required status check contexts from branch protection", async () => {
    const http = new ScriptedHttp([{ status: 200, body: { checks: [{ context: "build" }, { context: "e2e" }] } }]);
    const required = await new GitHubStatusService(http).fetchRequiredContexts({
      repo: { owner: "o", name: "r" },
      token: "t",
      baseBranch: "main",
    });
    expect(required).toEqual(["build", "e2e"]);
  });

  it("treats an unprotected branch (404) as no required gating", async () => {
    const http = new ScriptedHttp([{ status: 404, body: { message: "Branch not protected" } }]);
    const required = await new GitHubStatusService(http).fetchRequiredContexts({
      repo: { owner: "o", name: "r" },
      token: "t",
      baseBranch: "main",
    });
    expect(required).toBeUndefined();
  });

  it("THROWS loudly on a 403 (token lacks Administration:read) — never a silent 'no gating'", async () => {
    // No-silent-fallback: a 403 silently degraded to `undefined` would DISABLE required-
    // check gating and let a PR merge without its required checks. It must surface loudly.
    const http = new ScriptedHttp([{ status: 403, body: { message: "Resource not accessible by integration" } }]);
    await expect(
      new GitHubStatusService(http).fetchRequiredContexts({
        repo: { owner: "o", name: "r" },
        token: "t",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/branch-protection read failed for main: HTTP 403/u);
  });

  it("retries a transient 5xx then (if persistent) THROWS loudly — not a silent empty", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      // A persistent 504 on the protection read survives the client's transient retry.
      return new Response("", { status: 504 });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });

    await expect(
      new GitHubStatusService(client).fetchRequiredContexts({
        repo: { owner: "o", name: "r" },
        token: "t",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/branch-protection read failed for main: HTTP 504/u);
    // The client retried the transient 504 before the persistent failure surfaced.
    expect(call).toBeGreaterThan(1);
    expect(slept.length).toBeGreaterThan(0);
  });

  it("includes requiredContexts in fetchPullRequestChecks when the base branch is protected", async () => {
    const http = new ScriptedHttp([
      { status: 200, body: { head: { sha: "deadbeef", ref: "feat" }, base: { ref: "main" } } },
      {
        status: 200,
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
      },
      { status: 200, body: { statuses: [] } },
      { status: 200, body: { contexts: ["build"] } },
    ]);
    const checks = await new GitHubStatusService(http).fetchPullRequestChecks({
      repo: { owner: "o", name: "r" },
      token: "t",
      pullNumber: 7,
    });
    expect(checks.requiredContexts).toEqual(["build"]);
    expect(checks.head.sha).toBe("deadbeef");
  });
});

class ScriptedHttp implements GitHubHttpClient {
  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(_input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("unexpected GitHub request");
    }
    return response;
  }
}
