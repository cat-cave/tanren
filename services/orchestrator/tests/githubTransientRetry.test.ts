// GitHub-5xx resilience: the FetchGitHubHttpClient retries the transient gateway/
// timeout set (502/503/504/408) + transport throws with bounded exponential backoff,
// surfaces a persistent transient failure LOUDLY after the ceiling (no silent
// success), and keeps the 401 re-mint + 403/429 rate-limit paths intact and
// composable with a 5xx burst. Also unit-covers the `isTransientStatus` classifier.

import { describe, expect, it } from "vitest";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";
import {
  DEFAULT_TRANSIENT_RETRIES,
  isTransientStatus,
  TRANSIENT_BACKOFF_MS,
} from "../src/engine/providers/githubRetry.js";

function headers(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(map)) h.set(key, value);
  return h;
}

describe("isTransientStatus — the SAFE transient set", () => {
  it("is true for 502/503/504/408 only", () => {
    expect(isTransientStatus(502)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(504)).toBe(true);
    expect(isTransientStatus(408)).toBe(true);
  });

  it("is false for a plain 500, 4xx client errors, the rate-limit codes, and 2xx", () => {
    // A 500 is too often a real non-self-healing error — deliberately excluded.
    expect(isTransientStatus(500)).toBe(false);
    // 401/403/429 have their OWN dedicated handling — never the blind transient retry.
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(429)).toBe(false);
    // Real client errors + success are never transient.
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientStatus(422)).toBe(false);
    expect(isTransientStatus(200)).toBe(false);
  });
});

describe("FetchGitHubHttpClient — transient 5xx retry (GitHub-5xx resilience)", () => {
  it("retries 504 (then 503, 502, 408) with exp backoff, then succeeds", async () => {
    const slept: number[] = [];
    const sequence = [504, 503, 502, 408, 200];
    let call = 0;
    const fetchImpl = (async () => {
      const status = sequence[call] ?? 200;
      call += 1;
      const body = status === 200 ? JSON.stringify({ ok: true }) : "";
      return new Response(body, { status });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({
      fetchImpl,
      sleep: async (ms) => void slept.push(ms),
      // Need enough headroom for the four transient hits.
      maxTransientRetries: 5,
    });
    const response = await client.request({ method: "GET", path: "/refs", token: "t" });

    // Five fetches total (four transient + the success).
    expect(call).toBe(5);
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    // Backoff schedule honored (500 → 1s → 2s, then the default 2s cap for the 4th).
    expect(slept).toEqual([500, 1_000, 2_000, 2_000]);
  });

  it("uses the documented 500ms→1s→2s schedule on the default ceiling", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      // Two transient hits then success — proves the first two backoff steps.
      const status = call <= 2 ? 503 : 200;
      return new Response(status === 200 ? JSON.stringify({ ok: 1 }) : "", { status });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    const response = await client.request({ method: "GET", path: "/x", token: "t" });

    expect(response.status).toBe(200);
    expect(slept).toEqual([TRANSIENT_BACKOFF_MS[0], TRANSIENT_BACKOFF_MS[1]]);
  });

  it("gives up LOUDLY after the transient ceiling (surfaces the raw 5xx, no silent success)", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response("", { status: 504 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    const response = await client.request({ method: "GET", path: "/y", token: "t" });

    // Initial attempt + DEFAULT_TRANSIENT_RETRIES retries, then the raw 504 surfaces.
    expect(call).toBe(DEFAULT_TRANSIENT_RETRIES + 1);
    expect(slept.length).toBe(DEFAULT_TRANSIENT_RETRIES);
    // The persistent 5xx is returned RAW — the caller's `!== 200` guard turns it into a
    // thrown error / infra-hold. It is NOT laundered into a success.
    expect(response.status).toBe(504);
  });

  it("retries a TRANSPORT throw (fetch rejects) under the same bound, then re-throws on exhaustion", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    await expect(client.request({ method: "GET", path: "/z", token: "t" })).rejects.toThrow(/ECONNRESET/u);
    expect(call).toBe(DEFAULT_TRANSIENT_RETRIES + 1);
    expect(slept.length).toBe(DEFAULT_TRANSIENT_RETRIES);
  });

  it("recovers from a transport throw that self-heals before the ceiling", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async () => {} });
    const response = await client.request({ method: "GET", path: "/z2", token: "t" });
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    expect(call).toBe(2);
  });

  it("does NOT retry a transient when the caller opts out (retryTransient:false) — surfaces the raw 5xx", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response("", { status: 504 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async () => {} });
    const response = await client.request({ method: "PUT", path: "/merge", token: "t", retryTransient: false });

    // One attempt only — the non-idempotent write handles its own 5xx reconciliation.
    expect(call).toBe(1);
    expect(response.status).toBe(504);
  });

  it("does NOT retry a transport throw when retryTransient:false (a non-idempotent write may have applied)", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async () => {} });
    await expect(client.request({ method: "PUT", path: "/merge", token: "t", retryTransient: false })).rejects.toThrow(
      /ETIMEDOUT/u,
    );
    expect(call).toBe(1);
  });
});

describe("FetchGitHubHttpClient — composable with 401 re-mint + 403/429 rate-limit", () => {
  it("handles a 503 then a 429 within the loop, then succeeds (both paths compose)", async () => {
    const slept: number[] = [];
    const sequence: Array<{ status: number; headers?: Record<string, string> }> = [
      { status: 503 },
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200 },
    ];
    let call = 0;
    const fetchImpl = (async () => {
      const next = sequence[call] ?? { status: 200 };
      call += 1;
      const body = next.status === 200 ? JSON.stringify({ ok: true }) : "";
      return new Response(body, { status: next.status, headers: headers(next.headers ?? {}) });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    const response = await client.request({ method: "GET", path: "/mix", token: "t" });

    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    // The 503 backed off 500ms (transient path); the 429 backed off 2s (rate-limit path).
    expect(slept).toEqual([500, 2_000]);
  });

  it("still re-mints once on a 401 (unchanged P3-0003 behavior)", async () => {
    let call = 0;
    let usedToken = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      call += 1;
      usedToken = String((init.headers as Record<string, string>).Authorization);
      if (call === 1) return new Response("", { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async () => {} });
    const response = await client.request({
      method: "GET",
      path: "/auth",
      token: "stale",
      refreshToken: async () => "fresh",
    });

    expect(response.status).toBe(200);
    expect(usedToken).toBe("Bearer fresh");
  });
});
