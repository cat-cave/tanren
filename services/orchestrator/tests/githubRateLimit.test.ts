// the GitHub HTTP client honors rate-limit signals (Retry-After /
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
  GitHubOutageError,
  isSecondaryRateLimitBody,
  MAX_RATE_LIMIT_BACKOFF_MS,
  MIN_RATE_LIMIT_BACKOFF_MS,
  rateLimitBackoffMs,
  TRANSIENT_BACKOFF_MS,
} from "../src/engine/providers/githubRetry.js";
import { evaluateCiObservation } from "../src/engine/workflow/ciObservation.js";

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

  it("surfaces the exact provider delay without sleeping when durable intake owns retry", async () => {
    const slept: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("", { status: 429, headers: headers({ "retry-after": "73" }) });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });

    const response = await client.request({
      method: "GET",
      path: "/intake",
      token: "t",
      retryRateLimit: false,
    });

    expect(response).toMatchObject({ status: 429, retryAfterMs: 73_000 });
    expect({ calls, slept }).toEqual({ calls: 1, slept: [] });
  });

  it("§4: honors a 429 Retry-After even AFTER a transient-503 burst", async () => {
    // The rate-limit path keeps its OWN signature stream, independent of the transient-503
    // stream, so a prior 503 burst never consumes the 429's honored Retry-After. The sequence
    // 503,503,503 → 429 → 200 fully self-heals: each 503 retries on the transient cadence, and
    // the 429 STILL gets its own Retry-After wait (no shared budget to pre-consume).
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call <= 3) {
        return new Response("", { status: 503 });
      }
      if (call === 4) {
        return new Response("", { status: 429, headers: headers({ "retry-after": "7" }) });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({
      fetchImpl,
      sleep: async (ms) => void slept.push(ms),
      // The transient-503 stream and the rate-limit stream are judged for convergence
      // INDEPENDENTLY, so the 503 burst never pre-consumes the later 429's honored Retry-After.
    });
    const response = await client.request({ method: "GET", path: "/rate", token: "t" });

    // The 429's 7s Retry-After WAS honored (the last sleep), proving the rate-limit
    // stream was not pre-consumed by the three transient 503 retry waits before it.
    expect(slept).toContain(7_000);
    expect(call).toBe(5);
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("apex-v35: classifies a SECONDARY rate-limit 403 (body only, no headers) as rate-limited", () => {
    const now = 1_000_000;
    const secondaryBody = {
      message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits",
    };
    // The bug: this 403 carries NEITHER `Retry-After` NOR `X-RateLimit-Remaining: 0`, so the
    // header-only classifier returned `undefined` and the engine hot-looped on a raw HTTP 403.
    // WITHOUT the body classifier this is undefined (the assertion that fails pre-fix):
    expect(rateLimitBackoffMs(403, get({}), now, secondaryBody)).toBe(MAX_RATE_LIMIT_BACKOFF_MS);
    expect(rateLimitBackoffMs(429, get({}), now, secondaryBody)).toBe(MAX_RATE_LIMIT_BACKOFF_MS);
    // The matcher is body-shape only; a non-secondary 403 body is still NOT rate-limited.
    expect(
      rateLimitBackoffMs(403, get({}), now, { message: "Resource not accessible by integration" }),
    ).toBeUndefined();
    expect(isSecondaryRateLimitBody(secondaryBody)).toBe(true);
    expect(isSecondaryRateLimitBody({ message: "Bad credentials" })).toBe(false);
  });

  it("apex-v35: backs off + RETRIES a secondary-rate-limit 403 (body only) then succeeds", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    const response = await client.request({ method: "GET", path: "/git/ref/heads/main", token: "t" });
    // Backed off the bounded secondary default (not a raw 403 hot-loop) then succeeded.
    expect(slept).toEqual([MAX_RATE_LIMIT_BACKOFF_MS]);
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("apex-v35: a TOKEN 403 force-mints ONCE then retries; a persistent genuine 403 surfaces loud", async () => {
    // (a) a token-403 clears after a single force-mint.
    let minted = 0;
    let call = 0;
    const fetchOnceThen200 = (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 403 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({ fetchImpl: fetchOnceThen200, sleep: async () => {} });
    const ok = await client.request({
      method: "GET",
      path: "/git/ref/heads/main",
      token: "stale",
      refreshToken: async () => {
        minted += 1;
        return "fresh";
      },
    });
    expect(minted).toBe(1);
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });

    // (b) a PERSISTENT genuine 403 (not rate-limit) re-mints ONCE then surfaces the 403 —
    // never an infinite re-mint loop, and the body is preserved for diagnosis.
    let mints2 = 0;
    let calls2 = 0;
    const fetchAlways403 = (async () => {
      calls2 += 1;
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    }) as unknown as typeof fetch;
    const client2 = new FetchGitHubHttpClient({ fetchImpl: fetchAlways403, sleep: async () => {} });
    const denied = await client2.request({
      method: "GET",
      path: "/git/ref/heads/main",
      token: "t",
      refreshToken: async () => {
        mints2 += 1;
        return "fresh";
      },
    });
    // Exactly one re-mint, then it gives up (no loop): the original + one retry after.
    expect(mints2).toBe(1);
    expect(calls2).toBe(2);
    expect(denied.status).toBe(403);
    expect(denied.errorDetail).toMatch(/Resource not accessible by integration/u);
  });

  it("escalates a PERSISTENT-IDENTICAL rate limit as an outage (non-convergence, not a count)", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      // The SAME 429 forever — GitHub never clears the window: a sustained outage, not a blip.
      return new Response("", { status: 429, headers: headers({ "retry-after": "2" }) });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });

    // It honors the Retry-After cadence, retries PAST the old fixed ceiling, and surfaces a loud
    // GitHubOutageError only once the identical rate-limit signal is a proven fixed point — never
    // a 3-strikes give-up, and never an infinite silent loop.
    await expect(client.request({ method: "GET", path: "/rate", token: "t" })).rejects.toBeInstanceOf(
      GitHubOutageError,
    );
    expect(call).toBeGreaterThan(TRANSIENT_BACKOFF_MS.length);
    // Every honored wait used the Retry-After cadence (2s) — the backoff is legitimate pacing.
    expect(slept.every((ms) => ms === 2_000)).toBe(true);
    expect(slept.length).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS.length);
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

  it("omits required gating only with separate authoritative protected=false proof", async () => {
    const http = new ScriptedHttp([
      { status: 200, body: { object: { sha: "deadbeef" } } },
      {
        status: 200,
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
      },
      { status: 200, body: { statuses: [] } },
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { name: "main", protected: false } },
    ]);
    const checks = await new GitHubStatusService(http).fetchBranchChecks({
      repo: { owner: "o", name: "r" },
      token: "t",
      branch: "main",
    });
    expect(checks.requiredContexts).toBeUndefined();
    expect(evaluateCiObservation(checks)).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });

  it("accepts review/restriction protection with an explicit proof of no classic status checks", async () => {
    const http = new ScriptedHttp([
      { status: 200, body: { object: { sha: "deadbeef" } } },
      {
        status: 200,
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
      },
      { status: 200, body: { statuses: [{ context: "legacy", state: "success" }] } },
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { name: "main", protected: true } },
      {
        status: 200,
        body: {
          required_status_checks: null,
          required_pull_request_reviews: { required_approving_review_count: 1 },
          restrictions: { users: [], teams: [], apps: [] },
        },
      },
      { status: 200, body: [{ type: "pull_request" }] },
    ]);
    const checks = await new GitHubStatusService(http).fetchBranchChecks({
      repo: { owner: "o", name: "r" },
      token: "t",
      branch: "main",
    });
    expect(checks.requiredContexts).toEqual([]);
    expect(evaluateCiObservation(checks)).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });

  it("accepts ruleset-only protection only after the rules document proves no status requirement", async () => {
    const http = new ScriptedHttp([
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { name: "main", protected: true } },
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: [{ type: "pull_request" }, { type: "deletion" }] },
    ]);
    await expect(
      new GitHubStatusService(http).fetchRequiredContexts({
        repo: { owner: "o", name: "r" },
        token: "t",
        baseBranch: "main",
      }),
    ).resolves.toEqual([]);
  });

  it("fails closed on ambiguous or malformed protection proof and never emits a pass effect", async () => {
    for (const [protection, rules, message] of [
      [{ status: 404, body: {} }, { status: 200, body: [] }, /no full protection or ruleset proof/u],
      [{ status: 200, body: { required_status_checks: {} } }, { status: 200, body: [] }, /did not prove/u],
      [{ status: 404, body: {} }, { status: 200, body: [{}] }, /missing type/u],
      [
        { status: 404, body: {} },
        { status: 200, body: [{ type: "required_status_checks" }] },
        /require status checks/u,
      ],
    ] as const) {
      const http = new ScriptedHttp([
        { status: 200, body: { object: { sha: "deadbeef" } } },
        { status: 200, body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] } },
        { status: 200, body: { statuses: [] } },
        { status: 404, body: { message: "Not Found" } },
        { status: 200, body: { name: "main", protected: true } },
        protection,
        rules,
      ]);
      let passedEffects = 0;
      await expect(
        new GitHubStatusService(http)
          .fetchBranchChecks({ repo: { owner: "o", name: "r" }, token: "t", branch: "main" })
          .then((checks) => {
            if (evaluateCiObservation(checks).status === "passed") passedEffects += 1;
          }),
      ).rejects.toThrow(message);
      expect(passedEffects).toBe(0);
    }
  });

  it("fails closed when the unprotected branch proof has no matching branch identity", async () => {
    for (const proof of [{ protected: false }, { name: "release", protected: false }]) {
      const http = new ScriptedHttp([
        { status: 200, body: { object: { sha: "deadbeef" } } },
        { status: 200, body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] } },
        { status: 200, body: { statuses: [] } },
        { status: 404, body: { message: "Not Found" } },
        { status: 200, body: proof },
      ]);
      let passedEffects = 0;
      await expect(
        new GitHubStatusService(http)
          .fetchBranchChecks({ repo: { owner: "o", name: "r" }, token: "t", branch: "main" })
          .then((checks) => {
            if (evaluateCiObservation(checks).status === "passed") passedEffects += 1;
          }),
      ).rejects.toThrow(/branch response name did not match requested branch/u);
      expect(passedEffects).toBe(0);
    }
  });

  it("fails closed when the branch proof is missing, denied, raced away, or malformed", async () => {
    const input = { repo: { owner: "o", name: "r" }, token: "t", baseBranch: "main" };
    for (const proof of [
      { status: 404, body: { message: "Not Found" } },
      { status: 403, body: { message: "Resource not accessible by integration" } },
      { status: 200, body: { name: "main" } },
    ]) {
      const http = new ScriptedHttp([{ status: 404, body: { message: "Not Found" } }, proof]);
      await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(
        /branch-protection|branch response/u,
      );
    }
  });

  it("rejects malformed required-context evidence instead of silently dropping it", async () => {
    const http = new ScriptedHttp([
      { status: 200, body: { checks: [{ context: "build" }, { context: 7 }], contexts: ["build"] } },
    ]);
    await expect(
      new GitHubStatusService(http).fetchRequiredContexts({
        repo: { owner: "o", name: "r" },
        token: "t",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/invalid check context/u);
  });

  it("rejects every present malformed required-context sibling before a CI pass can escape", async () => {
    for (const body of [
      { checks: [], contexts: "not-an-array" },
      { checks: "not-an-array", contexts: ["build"] },
    ]) {
      const http = new ScriptedHttp([
        { status: 200, body: { object: { sha: "deadbeef" } } },
        { status: 200, body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] } },
        { status: 200, body: { statuses: [] } },
        { status: 200, body },
      ]);
      let passedEffects = 0;
      await expect(
        new GitHubStatusService(http)
          .fetchBranchChecks({ repo: { owner: "o", name: "r" }, token: "t", branch: "main" })
          .then((checks) => {
            if (evaluateCiObservation(checks).status === "passed") passedEffects += 1;
          }),
      ).rejects.toThrow(/non-array (checks|contexts) field/u);
      expect(passedEffects).toBe(0);
    }
  });

  it("rejects a PR response without a base branch before assembling a check snapshot", async () => {
    const http = new ScriptedHttp([{ status: 200, body: { head: { sha: "deadbeef", ref: "feat" } } }]);
    await expect(
      new GitHubStatusService(http).fetchPullRequestChecks({
        repo: { owner: "o", name: "r" },
        token: "t",
        pullNumber: 7,
      }),
    ).rejects.toThrow(/PR response missing base branch/u);
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

  it("retries a transient 5xx then (if persistent) surfaces a loud OUTAGE — not a silent empty", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      // A persistent 504 on the protection read is a sustained outage — the client retries it
      // unbounded while it makes progress, then escalates LOUDLY on non-convergence (a fixed
      // point), never silently degrading to "no required gating".
      return new Response("", { status: 504 });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });

    await expect(
      new GitHubStatusService(client).fetchRequiredContexts({
        repo: { owner: "o", name: "r" },
        token: "t",
        baseBranch: "main",
      }),
    ).rejects.toBeInstanceOf(GitHubOutageError);
    // The client retried the transient 504 (past the old fixed cap) before the outage surfaced.
    expect(call).toBeGreaterThan(TRANSIENT_BACKOFF_MS.length);
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
