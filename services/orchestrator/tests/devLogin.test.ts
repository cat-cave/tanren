// Verifies the DEV-ONLY sign-in escape hatch (feat/dev-login-escape-hatch):
//   (a) with TANREN_DEV_LOGIN=1 the local_dev provider is registered and a
//       /auth/login -> /auth/callback handshake mints a session and creates the
//       synthetic dev org + admin user via the existing P2A-0003 upsert path;
//   (b) with the flag unset, local_dev is NOT registered (no behavior change);
//   (c) the flag is refused under a prod-like (TANREN_COOKIE_SECURE=1) context.
// Deterministic: a fake identity pool, no real network, no DB.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildAuthFromEnv } from "../src/main.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createAuthRoutes } from "../src/routes/auth/index.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

const SAVED = {
  devLogin: process.env.TANREN_DEV_LOGIN,
  clientId: process.env.TANREN_GITHUB_OAUTH_CLIENT_ID,
  clientSecret: process.env.TANREN_GITHUB_OAUTH_CLIENT_SECRET,
  cookieSecure: process.env.TANREN_COOKIE_SECURE
};

function restore(key: keyof typeof SAVED, envName: string): void {
  const value = SAVED[key];
  if (value === undefined) {
    delete process.env[envName];
  } else {
    process.env[envName] = value;
  }
}

beforeEach(() => {
  delete process.env.TANREN_DEV_LOGIN;
  delete process.env.TANREN_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.TANREN_GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.TANREN_COOKIE_SECURE;
});

afterEach(() => {
  restore("devLogin", "TANREN_DEV_LOGIN");
  restore("clientId", "TANREN_GITHUB_OAUTH_CLIENT_ID");
  restore("clientSecret", "TANREN_GITHUB_OAUTH_CLIENT_SECRET");
  restore("cookieSecure", "TANREN_COOKIE_SECURE");
});

describe("dev-login escape hatch (buildAuthFromEnv)", () => {
  it("does not register local_dev (and returns undefined) when the flag is unset", () => {
    const pool = createFakeIdentityPool();
    const auth = buildAuthFromEnv(pool.asPgPool());
    // No github_oauth env and no dev flag => no providers => undefined (today's
    // behavior: no /auth routes, no auth middleware).
    expect(auth).toBeUndefined();
  });

  it("registers local_dev only when TANREN_DEV_LOGIN=1", () => {
    process.env.TANREN_DEV_LOGIN = "1";
    const pool = createFakeIdentityPool();
    const auth = buildAuthFromEnv(pool.asPgPool());
    expect(auth).toBeDefined();
    expect(auth?.providers.has("local_dev")).toBe(true);
    expect(auth?.providers.has("github_oauth")).toBe(false);
  });

  it("refuses the flag under a prod-like TANREN_COOKIE_SECURE=1 context", () => {
    process.env.TANREN_DEV_LOGIN = "1";
    process.env.TANREN_COOKIE_SECURE = "1";
    const pool = createFakeIdentityPool();
    const auth = buildAuthFromEnv(pool.asPgPool());
    // No other providers => undefined; local_dev is not honored.
    expect(auth).toBeUndefined();
  });

  it("local_dev handshake mints a session and creates the dev org + admin", async () => {
    process.env.TANREN_DEV_LOGIN = "1";
    const pool = createFakeIdentityPool();
    const auth = buildAuthFromEnv(pool.asPgPool());
    expect(auth).toBeDefined();
    if (auth === undefined) return;

    const app = new Hono<ActorContextEnv>();
    app.route(
      "/auth",
      createAuthRoutes({
        providers: auth.providers,
        store: auth.store,
        publicBaseUrl: auth.publicBaseUrl,
        cookieSecure: auth.cookieSecure
      })
    );
    app.use("*", createAuthMiddleware({ store: auth.store }));
    app.get("/runs/:runId", (c) => c.json({ actor: c.var.actor }));

    // Protected route is 401 before sign-in.
    const before = await app.request("/runs/run_x");
    expect(before.status).toBe(401);

    // login -> grab state cookie.
    const login = await app.request("/auth/login?provider=local_dev");
    expect(login.status).toBe(302);
    const state = decodeURIComponent(
      /tanren_oauth_state=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""
    );
    expect(state).not.toBe("");

    // callback mints the session + creates org/admin (P2A-0003 path).
    const callback = await app.request(
      `/auth/callback?provider=local_dev&code=local-dev&state=${state}`,
      { headers: { cookie: `tanren_oauth_state=${state}` } }
    );
    expect(callback.status).toBe(200);
    const callbackJson = (await callback.json()) as {
      ok: boolean;
      orgs: { login: string }[];
      primaryOrgId: string;
    };
    expect(callbackJson.ok).toBe(true);
    expect(callbackJson.orgs.map((o) => o.login)).toContain("tanren-dev");
    expect(callbackJson.primaryOrgId).not.toBe("");

    const sessionId = decodeURIComponent(
      /tanren_session=([^;]+)/.exec(callback.headers.get("set-cookie") ?? "")?.[1] ?? ""
    );
    expect(sessionId).not.toBe("");

    // Session resolves an actor on a protected route.
    const after = await app.request("/runs/run_x", {
      headers: { cookie: `tanren_session=${sessionId}` }
    });
    expect(after.status).toBe(200);
    const afterJson = (await after.json()) as { actor: { source: string; orgId: string | null } };
    expect(afterJson.actor.source).toBe("session");

    // The synthetic org + admin membership exist in the store.
    const orgs = [...pool.orgs.values()];
    expect(orgs.some((o) => o.login === "tanren-dev" && o.external_id === "tanren-dev-org")).toBe(true);
    const adminMemberships = [...pool.orgMembers.values()].filter((m) => m.role === "admin");
    expect(adminMemberships.length).toBe(1);
  });
});
