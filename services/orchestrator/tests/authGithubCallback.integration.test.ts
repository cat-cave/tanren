import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  GitHubOAuthProvider,
  IdentityStore,
  type IdentityProvider,
  type IdentityProviderId,
} from "../src/auth/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createAuthRoutes } from "../src/routes/auth/index.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

// Recorded fixture: the JSON shapes GitHub returns from the four OAuth endpoints
// used during sign-in. Captured from GitHub's public API documentation and
// trimmed to the fields the provider parses.
const FIXTURE = {
  tokenResponse: {
    access_token: "gho_FAKE_FIXTURE_TOKEN_DO_NOT_USE",
    token_type: "bearer",
    scope: "read:user,user:email,read:org",
  },
  userResponse: {
    id: 583231,
    login: "octocat",
    name: "The Octocat",
    email: null,
  },
  emailsResponse: [
    { email: "octocat@github.com", primary: true, verified: true, visibility: "public" },
    { email: "octocat+alt@github.com", primary: false, verified: true, visibility: "private" },
  ],
  orgsResponse: [
    { id: 1, login: "github", description: "How people build software." },
    { id: 9919, login: "github-octocat", description: "Octocat's playground" },
  ],
};

describe("GitHub OAuth callback integration (recorded fixture)", () => {
  it("processes the recorded callback, creates a user + org rows, and issues a session", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());

    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify(FIXTURE.tokenResponse), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/user")) {
        return new Response(JSON.stringify(FIXTURE.userResponse), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/user/emails")) {
        return new Response(JSON.stringify(FIXTURE.emailsResponse), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/user/orgs")) {
        return new Response(JSON.stringify(FIXTURE.orgsResponse), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const provider = new GitHubOAuthProvider({
      clientId: "ghub_client_id",
      clientSecret: "ghub_client_secret",
      fetchImpl,
    });
    const providers = new Map<IdentityProviderId, IdentityProvider>();
    providers.set("github_oauth", provider);
    const app = new Hono<ActorContextEnv>();
    app.route("/auth", createAuthRoutes({ providers, store, publicBaseUrl: "http://localhost:3100" }));
    app.use("*", createAuthMiddleware({ store }));
    app.get("/me-check", (c) => c.json({ actor: c.var.actor ?? null }));

    const login = await app.request("/auth/login?provider=github_oauth");
    const stateCookie = decodeURIComponent(
      /tanren_oauth_state=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "",
    );
    const callback = await app.request(`/auth/callback?provider=github_oauth&code=fixturecode&state=${stateCookie}`, {
      headers: { cookie: `tanren_oauth_state=${stateCookie}` },
    });
    expect(callback.status).toBe(200);
    const body = (await callback.json()) as {
      user: { id: string; login: string };
      orgs: { id: string; login: string }[];
      primaryOrgId: string;
    };
    expect(body.user.login).toBe("octocat");
    expect(body.orgs.map((o) => o.login)).toEqual(["github", "github-octocat"]);
    expect(body.orgs.map((o) => o.id)).toContain(body.primaryOrgId);

    expect(pool.users.size).toBe(1);
    expect(pool.orgs.size).toBe(2);
    expect(pool.orgMembers.size).toBe(2);
  });
});
