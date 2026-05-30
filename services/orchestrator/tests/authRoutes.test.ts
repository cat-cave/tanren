import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  IdentityStore,
  LocalDevProvider,
  OidcProvider,
  type IdentityClaims,
  type IdentityProviderId,
  type IdentityProvider,
} from "../src/auth/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createAuthRoutes } from "../src/routes/auth/index.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

function buildHarness(identity: IdentityClaims) {
  const pool = createFakeIdentityPool();
  const store = new IdentityStore(pool.asPgPool());
  const provider = new LocalDevProvider({ identity });
  const providers = new Map<IdentityProviderId, IdentityProvider>([["local_dev", provider]]);
  const app = new Hono<ActorContextEnv>();
  app.route("/auth", createAuthRoutes({ providers, store, publicBaseUrl: "http://localhost:3100" }));
  app.use("*", createAuthMiddleware({ store }));
  app.get("/runs/:runId", (c) => c.json({ runId: c.req.param("runId"), actor: c.var.actor }));
  app.post("/projects", (c) => c.json({ actor: c.var.actor }));
  return { app, pool, store, provider };
}

const aliceIdentity: IdentityClaims = {
  providerSubject: "alice-1",
  login: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  orgs: [{ externalId: "100", login: "acme", displayName: "Acme", kind: "github_org" }],
};

describe("auth routes and middleware", () => {
  it("rejects unauthenticated requests to protected routes with 401", async () => {
    const { app } = buildHarness(aliceIdentity);
    const response = await app.request("/runs/run_x");
    expect(response.status).toBe(401);
  });

  it("oauth login redirects to provider and callback issues a session cookie", async () => {
    const { app } = buildHarness(aliceIdentity);
    const login = await app.request("/auth/login?provider=local_dev");
    expect(login.status).toBe(302);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("tanren_oauth_state=");
    const stateMatch = /tanren_oauth_state=([^;]+)/.exec(setCookie);
    expect(stateMatch).not.toBeNull();
    const state = decodeURIComponent(stateMatch?.[1] ?? "");
    const callback = await app.request(`/auth/callback?provider=local_dev&code=anything&state=${state}`, {
      headers: { cookie: `tanren_oauth_state=${state}` },
    });
    expect(callback.status).toBe(200);
    const callbackCookie = callback.headers.get("set-cookie") ?? "";
    expect(callbackCookie).toContain("tanren_session=");
    const sessionMatch = /tanren_session=([^;]+)/.exec(callbackCookie);
    const sessionId = decodeURIComponent(sessionMatch?.[1] ?? "");
    expect(sessionId).not.toBe("");
    const json = (await callback.json()) as { csrfToken: string };
    expect(json.csrfToken).toMatch(/^[a-f0-9]+$/);

    const runResponse = await app.request("/runs/run_x", {
      headers: { cookie: `tanren_session=${sessionId}` },
    });
    expect(runResponse.status).toBe(200);
    const runJson = (await runResponse.json()) as { actor: { userId: string; source: string } };
    expect(runJson.actor.source).toBe("session");
  });

  it("state mismatch on callback returns 400", async () => {
    const { app } = buildHarness(aliceIdentity);
    const callback = await app.request("/auth/callback?provider=local_dev&code=anything&state=wrong", {
      headers: { cookie: "tanren_oauth_state=expected" },
    });
    expect(callback.status).toBe(400);
  });

  it("state-changing routes require a matching csrf header", async () => {
    const { app } = buildHarness(aliceIdentity);
    const login = await app.request("/auth/login?provider=local_dev");
    const stateCookie = login.headers.get("set-cookie") ?? "";
    const state = decodeURIComponent(/tanren_oauth_state=([^;]+)/.exec(stateCookie)?.[1] ?? "");
    const callback = await app.request(`/auth/callback?provider=local_dev&code=any&state=${state}`, {
      headers: { cookie: `tanren_oauth_state=${state}` },
    });
    const callbackJson = (await callback.json()) as { csrfToken: string };
    const sessionCookie = decodeURIComponent(
      /tanren_session=([^;]+)/.exec(callback.headers.get("set-cookie") ?? "")?.[1] ?? "",
    );

    const missingCsrf = await app.request("/projects", {
      method: "POST",
      headers: { cookie: `tanren_session=${sessionCookie}` },
    });
    expect(missingCsrf.status).toBe(403);

    const withCsrf = await app.request("/projects", {
      method: "POST",
      headers: {
        cookie: `tanren_session=${sessionCookie}`,
        "x-csrf-token": callbackJson.csrfToken,
      },
    });
    expect(withCsrf.status).toBe(200);
  });

  it("api token bearer auth resolves an actor context", async () => {
    const { app, store } = buildHarness(aliceIdentity);
    const { user } = await store.upsertIdentity("github_oauth", aliceIdentity);
    const token = await store.createApiToken({
      userId: user.id,
      name: "cli",
      scopes: ["read", "write"],
    });
    const response = await app.request("/runs/run_x", {
      headers: { Authorization: `Bearer ${token.rawToken}` },
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { actor: { userId: string; source: string } };
    expect(json.actor.userId).toBe(user.id);
    expect(json.actor.source).toBe("api_token");
  });

  it("invalid api token returns 401", async () => {
    const { app } = buildHarness(aliceIdentity);
    const response = await app.request("/runs/run_x", {
      headers: { Authorization: "Bearer tnt_bogus" },
    });
    expect(response.status).toBe(401);
  });

  it("OIDC provider builds an authorize URL and exchanges a code via mocked endpoints (P3-0030)", async () => {
    const issuer = "https://idp.example.com";
    const discovery = {
      issuer,
      authorization_endpoint: `${issuer}/application/o/authorize/`,
      token_endpoint: `${issuer}/application/o/token/`,
      userinfo_endpoint: `${issuer}/application/o/userinfo/`,
    };
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(discovery), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === discovery.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sub: "sub-1", preferred_username: "octo" }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const oidc = new OidcProvider({ issuer, clientId: "x", clientSecret: "y", fetchImpl });
    expect(oidc.id).toBe("oidc");
    expect(oidc.buildAuthorizeUrl("s", "https://cb")).toContain("response_type=code");
    const claims = await oidc.exchangeCode("c", "https://cb");
    expect(claims.providerSubject).toBe("sub-1");
    expect(claims.login).toBe("octo");
  });
});
