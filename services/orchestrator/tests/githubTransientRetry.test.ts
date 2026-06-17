// GitHub-5xx resilience (TIMEOUT-ERADICATION, feedback_no_timeouts_progress_based): the
// FetchGitHubHttpClient retries the transient gateway/timeout set (502/503/504/408) +
// transport throws on transient INDEFINITELY while the signal makes PROGRESS, spaced by the
// backoff curve (cadence, not a cap). A transient that keeps CHANGING / eventually resolves
// self-heals past the old fixed cap; a PERSISTENT-IDENTICAL transient escalates LOUDLY as a
// `GitHubOutageError` on intelligent NON-CONVERGENCE (a proven fixed point at the saturated
// backoff), NEVER on a 3-strikes count. The 401 re-mint + 403/429 rate-limit paths stay intact
// and composable with a 5xx burst. Also unit-covers the `isTransientStatus` classifier.

import { describe, expect, it } from "vitest";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";
import {
  GitHubOutageError,
  isTransientStatus,
  SATURATED_TRANSIENT_BACKOFF_MS,
  TRANSIENT_BACKOFF_MS,
  transientBackoffMs,
  transientFixedPointReached,
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

describe("transientBackoffMs — saturating cadence (not a cap)", () => {
  it("ramps the curve then holds the saturated cadence indefinitely", () => {
    expect(transientBackoffMs(0)).toBe(TRANSIENT_BACKOFF_MS[0]);
    expect(transientBackoffMs(1)).toBe(TRANSIENT_BACKOFF_MS[1]);
    expect(transientBackoffMs(2)).toBe(TRANSIENT_BACKOFF_MS[2]);
    // Past the curve every index returns the saturated steady-state spacing — defined for ALL
    // n (the loop is unbounded), never undefined / never a cap.
    expect(transientBackoffMs(3)).toBe(SATURATED_TRANSIENT_BACKOFF_MS);
    expect(transientBackoffMs(50)).toBe(SATURATED_TRANSIENT_BACKOFF_MS);
  });
});

describe("transientFixedPointReached — escalate on non-convergence, NOT a count", () => {
  it("never escalates while the backoff is still ramping (a short transient blip is progress)", () => {
    expect(transientFixedPointReached([])).toBe(false);
    expect(transientFixedPointReached(["http-503"])).toBe(false);
    expect(transientFixedPointReached(["http-503", "http-503"])).toBe(false);
    // At/under the ramp length there is no escalation even when identical — still legitimate pacing.
    expect(transientFixedPointReached(["http-503", "http-503", "http-503"])).toBe(false);
  });

  it("escalates only once the SAME signal is stuck past the saturated backoff (a fixed point)", () => {
    expect(transientFixedPointReached(["http-503", "http-503", "http-503", "http-503"])).toBe(true);
    expect(transientFixedPointReached(["transport", "transport", "transport", "transport"])).toBe(true);
  });

  it("a signal still exploring NEW states is forward motion — does not escalate", () => {
    // Each new transient introduces a state not yet seen (503→504→502→408): the loop is still
    // discovering new information, so it is progress, not a stuck fixed point.
    expect(transientFixedPointReached(["http-503", "http-504", "http-502", "http-408"])).toBe(false);
  });

  it("an OSCILLATION among a stuck set (503↔504 flapping) IS non-convergence — a flapping outage", () => {
    // A bounded A→B→A→B flap with no new information is the convergence detector's cycle: a
    // genuinely flapping GitHub outage, surfaced rather than retried forever.
    expect(transientFixedPointReached(["http-503", "http-504", "http-503", "http-504", "http-503"])).toBe(true);
  });
});

describe("FetchGitHubHttpClient — transient 5xx retry (GitHub-5xx resilience)", () => {
  it("retries 504 (then 503, 502, 408) with exp backoff PAST the old fixed cap, then succeeds", async () => {
    const slept: number[] = [];
    // Four DISTINCT transient hits (the signal keeps CHANGING = progress) then success. Under
    // the old fixed cap (3) this would have surfaced the 4th raw; with progress-based retry the
    // changing signal is forward motion and it self-heals — no cap option needed.
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
    });
    const response = await client.request({ method: "GET", path: "/refs", token: "t" });

    // Five fetches total (four transient + the success) — well past the old 3-retry cap.
    expect(call).toBe(5);
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    // Backoff schedule honored (500 → 1s → 2s, then the saturated 2s cadence for the 4th).
    expect(slept).toEqual([500, 1_000, 2_000, SATURATED_TRANSIENT_BACKOFF_MS]);
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

  it("escalates LOUDLY on a PERSISTENT-IDENTICAL 5xx (intelligent non-convergence, not a count)", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      // The SAME 504 forever — a proven fixed point at the saturated backoff: a sustained outage.
      return new Response("", { status: 504 });
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    // It surfaces a loud GitHubOutageError — NOT a returned raw 504, and NOT on a 3-strikes cap:
    // it retried PAST the old fixed cap, only escalating once the identical signal is stuck at the
    // saturated backoff (the convergence detector's fixed point).
    await expect(client.request({ method: "GET", path: "/y", token: "t" })).rejects.toBeInstanceOf(GitHubOutageError);
    // It retried beyond the old fixed cap (3) before the non-convergence escalation.
    expect(call).toBeGreaterThan(TRANSIENT_BACKOFF_MS.length);
    expect(slept.length).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS.length);
    // The cadence saturated at the steady-state spacing (proves backoff is still legitimate pacing).
    expect(slept.at(-1)).toBe(SATURATED_TRANSIENT_BACKOFF_MS);
  });

  it("retries a TRANSPORT throw (fetch rejects) UNBOUNDED, re-throwing only on non-convergence", async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const client = new FetchGitHubHttpClient({ fetchImpl, sleep: async (ms) => void slept.push(ms) });
    // A persistent-identical transport throw is non-converging — the ORIGINAL throw re-surfaces
    // (loud), but only after retrying past the old fixed cap at the saturated cadence.
    await expect(client.request({ method: "GET", path: "/z", token: "t" })).rejects.toThrow(/ECONNRESET/u);
    expect(call).toBeGreaterThan(TRANSIENT_BACKOFF_MS.length);
    expect(slept.length).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS.length);
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
