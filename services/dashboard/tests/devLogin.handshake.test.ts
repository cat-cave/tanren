// Unit test for the dev-login BFF handshake helper (services/dashboard/src/auth/session.ts).
//
// The bug: with the dashboard and orchestrator on different origins (the
// orchestrator's ORCHESTRATOR_URL is the docker-internal http://orchestrator:3100),
// the old `/auth/login` 302'd the BROWSER to that unresolvable host. The fix runs
// the whole login→callback handshake SERVER-SIDE against the internal base, then
// re-emits the minted `tanren_session` cookie on the dashboard's own origin.
//
// These cases mock fetch to emulate the orchestrator's local_dev provider:
//   step 1: GET /auth/login → 302 to the callback URL + Set-Cookie state cookie;
//   step 2: GET /auth/callback (with the forwarded state cookie) → 200 + session cookie.
// We assert the helper forwards the state cookie and returns the session Set-Cookie + next.

import { describe, expect, it } from "vitest";
import { devLoginHandshake, DevLoginHandshakeError } from "../src/auth/session.js";

const ORCH = "http://orchestrator:3100";
const STATE = "abc123state";
const SESSION_COOKIE = "tanren_session=sess-xyz; Path=/; HttpOnly; SameSite=Lax";

/**
 * Build a fetch mock for the two-step handshake. Records the requests it saw so
 * tests can assert the dashboard forwarded the state cookie to the callback.
 */
function makeFetchMock(overrides: {
  loginStatus?: number;
  loginLocation?: string | null;
  loginStateCookie?: string | null;
  callbackStatus?: number;
  callbackSessionCookie?: string | null;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url.includes("/auth/login")) {
      const headers = new Headers();
      const loc = overrides.loginLocation === undefined
        ? `${ORCH}/auth/callback?provider=local_dev&state=${STATE}&code=local-dev`
        : overrides.loginLocation;
      if (loc !== null) headers.set("location", loc);
      const stateCookie = overrides.loginStateCookie === undefined
        ? `tanren_oauth_state=${STATE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
        : overrides.loginStateCookie;
      if (stateCookie !== null) headers.append("set-cookie", stateCookie);
      return new Response(null, { status: overrides.loginStatus ?? 302, headers });
    }
    if (url.includes("/auth/callback")) {
      const headers = new Headers();
      const sessionCookie = overrides.callbackSessionCookie === undefined
        ? SESSION_COOKIE
        : overrides.callbackSessionCookie;
      if (sessionCookie !== null) headers.append("set-cookie", sessionCookie);
      return new Response(JSON.stringify({ ok: true }), {
        status: overrides.callbackStatus ?? 200,
        headers
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("devLoginHandshake", () => {
  it("forwards the state cookie to the callback and returns the session cookie + next", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const result = await devLoginHandshake(ORCH, "/projects", fetchImpl);

    expect(result.sessionSetCookie).toBe(SESSION_COOKIE);
    expect(result.next).toBe("/projects");

    expect(calls).toHaveLength(2);
    const [step1, step2] = calls;

    // Step 1 hit the internal orchestrator login with the local_dev provider + next.
    expect(step1.url).toContain(`${ORCH}/auth/login`);
    expect(step1.url).toContain("provider=local_dev");
    expect(step1.url).toContain("next=%2Fprojects");
    expect((step1.init as RequestInit).redirect).toBe("manual");

    // Step 2 hit the internal callback, carrying the state cookie from step 1.
    expect(step2.url).toContain(`${ORCH}/auth/callback`);
    expect(step2.url).toContain(`state=${STATE}`);
    expect(step2.url).toContain("code=local-dev");
    const cookieHeader = new Headers((step2.init as RequestInit).headers).get("cookie");
    expect(cookieHeader).toBe(`tanren_oauth_state=${STATE}`);
    expect((step2.init as RequestInit).redirect).toBe("manual");
  });

  it("accepts a 303 from the login step too", async () => {
    const { fetchImpl } = makeFetchMock({ loginStatus: 303 });
    const result = await devLoginHandshake(ORCH, "/", fetchImpl);
    expect(result.sessionSetCookie).toBe(SESSION_COOKIE);
  });

  it("throws when the login step does not redirect", async () => {
    const { fetchImpl } = makeFetchMock({ loginStatus: 200 });
    await expect(devLoginHandshake(ORCH, "/", fetchImpl)).rejects.toBeInstanceOf(DevLoginHandshakeError);
  });

  it("throws when the login step omits the state cookie", async () => {
    const { fetchImpl } = makeFetchMock({ loginStateCookie: null });
    await expect(devLoginHandshake(ORCH, "/", fetchImpl)).rejects.toBeInstanceOf(DevLoginHandshakeError);
  });

  it("throws when the callback does not succeed", async () => {
    const { fetchImpl } = makeFetchMock({ callbackStatus: 400 });
    await expect(devLoginHandshake(ORCH, "/", fetchImpl)).rejects.toBeInstanceOf(DevLoginHandshakeError);
  });

  it("throws when the callback omits the session cookie", async () => {
    const { fetchImpl } = makeFetchMock({ callbackSessionCookie: null });
    await expect(devLoginHandshake(ORCH, "/", fetchImpl)).rejects.toBeInstanceOf(DevLoginHandshakeError);
  });

  it("resolves a relative Location against the orchestrator base", async () => {
    const { fetchImpl, calls } = makeFetchMock({
      loginLocation: "/auth/callback?provider=local_dev&state=" + STATE + "&code=local-dev"
    });
    const result = await devLoginHandshake(ORCH, "/", fetchImpl);
    expect(result.sessionSetCookie).toBe(SESSION_COOKIE);
    expect(calls[1]).toBeDefined();
    expect(calls[1].url).toBe(`${ORCH}/auth/callback?provider=local_dev&state=${STATE}&code=local-dev`);
  });
});
