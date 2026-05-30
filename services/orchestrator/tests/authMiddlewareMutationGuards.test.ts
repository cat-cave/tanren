// Behavior-based mutation guards for the operator-auth request path
// (test/mutation-ratchet-auth) — part 3 of 3: the request auth middleware
// (accept/reject decisions, actor-context + org/scope derivation, CSRF,
// public-path bypass), the cookie helpers, and the identity/session/token zod
// schema validation contract. Middleware tests drive real HTTP status/body
// through a Hono app backed by an injected Postgres stub; schema tests drive
// real parse accept/reject outcomes. No module mocking. Companion files:
// authProviderMutationGuards (providers) and authStoreMutationGuards (identity
// store + env builders).

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ActorContextSchema,
  ActorScopeSchema,
  ApiTokenSchema,
  IdentityClaimsSchema,
  IdentityOrgClaimSchema,
  IdentityProviderIdSchema,
  IdentityStore,
  OrgKindSchema,
  OrgMemberRoleSchema,
  OrgSchema,
  ProjectMemberRoleSchema,
  SessionSchema,
  TokenScopeSchema,
  UserSchema,
} from "../src/auth/index.js";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  clearSessionCookie,
  createAuthMiddleware,
  getRequestOrgId,
  readCookie,
  setSessionCookie,
  type ActorContextEnv,
} from "../src/middleware/auth.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

// =============================================================================
// Request auth middleware: actor-context resolution + org/scope derivation
// =============================================================================

function middlewareHarness(opts?: Partial<Parameters<typeof createAuthMiddleware>[0]>) {
  const pool = createFakeIdentityPool();
  const store = new IdentityStore(pool.asPgPool());
  const app = new Hono<ActorContextEnv>();
  app.use("*", createAuthMiddleware({ store, ...opts }));
  app.get("/runs/:runId", (c) => c.json({ actor: c.var.actor, requestOrgId: getRequestOrgId(c) }));
  app.post("/runs/:runId", (c) => c.json({ actor: c.var.actor }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  return { app, pool, store };
}

async function seedSession(
  store: IdentityStore,
): Promise<{ sessionId: string; csrf: string; userId: string; orgId: string }> {
  const { user, orgs } = await store.upsertIdentity("github_oauth", {
    providerSubject: "1",
    login: "alice",
    email: null,
    displayName: "Alice",
    orgs: [{ externalId: "1", login: "acme", displayName: "Acme", kind: "github_org" }],
  });
  const session = await store.createSession(user.id);
  return { sessionId: session.id, csrf: session.csrfToken, userId: user.id, orgId: orgs[0]?.id ?? "" };
}

describe("auth middleware deny/allow + actor-context guards", () => {
  const harness = middlewareHarness;

  it("returns 401 with an unauthorized body when no credentials are presented", async () => {
    const { app } = harness();
    const res = await app.request("/runs/r1");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("lets public paths through without authentication", async () => {
    const { app } = harness();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("rejects an unknown bearer token with 401 'invalid api token'", async () => {
    const { app } = harness();
    const res = await app.request("/runs/r1", { headers: { Authorization: "Bearer tnt_nope" } });
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe("invalid api token");
  });

  it("resolves an api_token actor and binds requestOrgId from the org header", async () => {
    const { app, store } = harness();
    const { user, orgs } = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "alice",
      email: null,
      displayName: "Alice",
      orgs: [{ externalId: "1", login: "acme", displayName: "Acme", kind: "github_org" }],
    });
    const token = await store.createApiToken({ userId: user.id, name: "cli", scopes: ["read"] });
    const res = await app.request("/runs/r1", {
      headers: { Authorization: `Bearer ${token.rawToken}`, "x-tanren-org-id": orgs[0]?.id ?? "" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor.source).toBe("api_token");
    expect(body.actor.userId).toBe(user.id);
    expect(body.actor.scopes).toContain("org:admin");
    // requestOrgId mirrors the resolved actor org (RLS root).
    expect(body.requestOrgId).toBe(orgs[0]?.id);
  });

  it("parses the bearer token case-insensitively and trims surrounding whitespace", async () => {
    const { app, store } = harness();
    const { user } = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "alice",
      email: null,
      displayName: "Alice",
      orgs: [],
    });
    const token = await store.createApiToken({ userId: user.id, name: "cli", scopes: ["read"] });
    const res = await app.request("/runs/r1", { headers: { Authorization: `  bearer   ${token.rawToken}  ` } });
    expect(res.status).toBe(200);
    expect((await res.json()).actor.userId).toBe(user.id);
  });

  it("resolves a session actor from the session cookie", async () => {
    const { app, store } = harness();
    const { sessionId, userId } = await seedSession(store);
    const res = await app.request("/runs/r1", { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor.source).toBe("session");
    expect(body.actor.userId).toBe(userId);
  });

  it("requires a matching csrf header for state-changing session requests", async () => {
    const { app, store } = harness();
    const { sessionId, csrf } = await seedSession(store);

    const missing = await app.request("/runs/r1", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(missing.status).toBe(403);
    expect((await missing.json()).error).toBe("csrf_token_invalid");

    const wrong = await app.request("/runs/r1", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: "not-it" },
    });
    expect(wrong.status).toBe(403);

    const ok = await app.request("/runs/r1", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });
    expect(ok.status).toBe(200);
  });

  it("does not require a csrf header for safe (GET) session requests", async () => {
    const { app, store } = harness();
    const { sessionId } = await seedSession(store);
    const res = await app.request("/runs/r1", { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } });
    expect(res.status).toBe(200);
  });

  it("rejects a request whose session cookie is unknown/expired and no fallback exists", async () => {
    const { app } = harness();
    const res = await app.request("/runs/r1", { headers: { cookie: `${SESSION_COOKIE}=ghost` } });
    expect(res.status).toBe(401);
  });

  it("prefers the api token over the session cookie when both are present", async () => {
    const { app, store } = harness();
    const { sessionId } = await seedSession(store);
    const { user } = await store.upsertIdentity("github_oauth", {
      providerSubject: "2",
      login: "bob",
      email: null,
      displayName: "Bob",
      orgs: [],
    });
    const token = await store.createApiToken({ userId: user.id, name: "cli", scopes: ["read"] });
    const res = await app.request("/runs/r1", {
      headers: { Authorization: `Bearer ${token.rawToken}`, cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor.source).toBe("api_token");
    expect(body.actor.userId).toBe(user.id);
  });

  it("falls back to the localDevActor only when no token and no session resolve", async () => {
    const localDevActor = {
      userId: "dev",
      orgId: "org_dev",
      projectId: null,
      scopes: ["platform:admin" as const],
      source: "local_dev" as const,
    };
    const { app } = harness({ localDevActor });
    const res = await app.request("/runs/r1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor.source).toBe("local_dev");
    expect(body.requestOrgId).toBe("org_dev");
  });

  it("honors a custom public-paths set instead of the defaults", async () => {
    const { app } = harness({ publicPaths: new Set(["/runs/open"]) });
    // /healthz is no longer public under the override.
    expect((await app.request("/healthz")).status).toBe(401);
  });

  it("derives org scope from the orgId query param when no header is present", async () => {
    // extractOrgId precedence: header ?? query ?? param. With no header, query wins.
    const { app, store } = harness();
    const { sessionId, orgId } = await seedSession(store);
    const res = await app.request(`/runs/r1?orgId=${orgId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    const body = await res.json();
    expect(body.actor.orgId).toBe(orgId);
    expect(body.actor.scopes).toContain("org:admin");
  });

  it("prefers the org header over the orgId query param", async () => {
    const { app, store } = harness();
    const { sessionId, orgId } = await seedSession(store);
    // header points at the real org; query points at a bogus one. Header wins,
    // so the actor is a member; if query were preferred the org would drop out.
    const res = await app.request("/runs/r1?orgId=org_bogus", {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, "x-tanren-org-id": orgId },
    });
    expect((await res.json()).actor.orgId).toBe(orgId);
  });
});

// =============================================================================
// cookie + session-cookie helpers
// =============================================================================

function cookieCtx(headerValue: string | undefined) {
  return {
    req: { header: (name: string) => (name === "cookie" ? headerValue : undefined) },
  } as unknown as Parameters<typeof readCookie>[0];
}

describe("cookie helpers", () => {
  const ctx = cookieCtx;

  it("reads a named cookie value and url-decodes it", () => {
    expect(readCookie(ctx("a=1; tanren_session=ab%20cd; b=2"), SESSION_COOKIE)).toBe("ab cd");
  });

  it("returns undefined when the cookie header is absent or the name is missing", () => {
    expect(readCookie(ctx(), SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(ctx("other=1"), SESSION_COOKIE)).toBeUndefined();
  });

  it("does not treat a leading '=' (empty name) piece as a match", () => {
    // readCookie: `eq <= 0` continue. A `=value` piece has eq===0 -> skipped.
    expect(readCookie(ctx("=bad; tanren_session=good"), SESSION_COOKIE)).toBe("good");
  });

  it("matches the cookie name exactly, not as a prefix", () => {
    expect(readCookie(ctx("tanren_session_other=x; tanren_session=real"), SESSION_COOKIE)).toBe("real");
  });

  it("builds an HttpOnly SameSite=Lax session cookie and omits Secure by default", () => {
    const cookie = setSessionCookie("tok");
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("Max-Age");
  });

  it("adds Secure and Max-Age only when requested", () => {
    const cookie = setSessionCookie("tok", { secure: true, maxAgeSeconds: 3600 });
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("url-encodes the session cookie value", () => {
    expect(setSessionCookie("a b")).toContain(`${SESSION_COOKIE}=a%20b`);
  });

  it("clears the session cookie with Max-Age=0", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });
});

// =============================================================================
// identity schemas: the validation contract (enum members, min-length, nullable,
// defaults). These are the neutral identity/session/token wire shapes — a mutant
// that drops a `.min(1)`, swaps an enum member, or removes a `.default(...)`
// would silently accept malformed identities or change a default, so each test
// drives a real parse outcome (accept/reject + the resolved/defaulted value).
// =============================================================================

describe("identity schema validation contract", () => {
  it("accepts the three identity-provider ids and rejects anything else", () => {
    for (const id of ["github_oauth", "oidc", "local_dev"]) {
      expect(IdentityProviderIdSchema.parse(id)).toBe(id);
    }
    expect(IdentityProviderIdSchema.safeParse("saml").success).toBe(false);
    expect(IdentityProviderIdSchema.safeParse("").success).toBe(false);
  });

  it("accepts the three org kinds and rejects others", () => {
    for (const kind of ["github_org", "github_user", "oidc"]) {
      expect(OrgKindSchema.parse(kind)).toBe(kind);
    }
    expect(OrgKindSchema.safeParse("gitlab_group").success).toBe(false);
  });

  it("accepts admin/member org + project roles and only read/write/admin token scopes", () => {
    expect(OrgMemberRoleSchema.parse("admin")).toBe("admin");
    expect(OrgMemberRoleSchema.parse("member")).toBe("member");
    expect(OrgMemberRoleSchema.safeParse("owner").success).toBe(false);
    expect(ProjectMemberRoleSchema.parse("admin")).toBe("admin");
    expect(ProjectMemberRoleSchema.parse("member")).toBe("member");
    expect(ProjectMemberRoleSchema.safeParse("guest").success).toBe(false);
    expect(TokenScopeSchema.parse("write")).toBe("write");
    expect(TokenScopeSchema.parse("read")).toBe("read");
    expect(TokenScopeSchema.parse("admin")).toBe("admin");
    expect(TokenScopeSchema.safeParse("delete").success).toBe(false);
  });

  it("enumerates exactly the five actor scopes", () => {
    for (const scope of ["platform:admin", "org:admin", "org:member", "project:admin", "project:member"]) {
      expect(ActorScopeSchema.parse(scope)).toBe(scope);
    }
    expect(ActorScopeSchema.safeParse("org:owner").success).toBe(false);
    expect(ActorScopeSchema.safeParse("platform:member").success).toBe(false);
  });

  it("requires non-empty subject and defaults orgs to an empty array on IdentityClaims", () => {
    const parsed = IdentityClaimsSchema.parse({
      providerSubject: "s",
      login: null,
      email: null,
      displayName: null,
    });
    expect(parsed.orgs).toEqual([]);
    // empty subject is rejected (the `.min(1)` contract).
    expect(
      IdentityClaimsSchema.safeParse({ providerSubject: "", login: null, email: null, displayName: null }).success,
    ).toBe(false);
  });

  it("allows null login/email/displayName but rejects an empty-string email", () => {
    expect(
      IdentityClaimsSchema.safeParse({ providerSubject: "s", login: null, email: null, displayName: null }).success,
    ).toBe(true);
    // email has `.min(1).nullable()`: null ok, "" rejected.
    expect(
      IdentityClaimsSchema.safeParse({ providerSubject: "s", login: null, email: "", displayName: null }).success,
    ).toBe(false);
  });

  it("defaults an org-claim kind to github_org and requires non-empty login/externalId", () => {
    const claim = IdentityOrgClaimSchema.parse({ externalId: "1", login: "acme", displayName: "Acme" });
    expect(claim.kind).toBe("github_org");
    expect(IdentityOrgClaimSchema.safeParse({ externalId: "", login: "acme", displayName: "Acme" }).success).toBe(
      false,
    );
    expect(IdentityOrgClaimSchema.safeParse({ externalId: "1", login: "", displayName: "Acme" }).success).toBe(false);
  });

  it("requires a nullable-but-not-empty orgId/projectId on ActorContext and a valid source", () => {
    const ok = ActorContextSchema.parse({
      userId: "u",
      orgId: null,
      projectId: null,
      scopes: ["org:member"],
      source: "session",
    });
    expect(ok.orgId).toBeNull();
    // empty-string orgId is rejected (`.min(1).nullable()`).
    expect(
      ActorContextSchema.safeParse({ userId: "u", orgId: "", projectId: null, scopes: [], source: "session" }).success,
    ).toBe(false);
    // bad source enum is rejected.
    expect(
      ActorContextSchema.safeParse({ userId: "u", orgId: null, projectId: null, scopes: [], source: "cookie" }).success,
    ).toBe(false);
    // bad scope member is rejected.
    expect(
      ActorContextSchema.safeParse({ userId: "u", orgId: null, projectId: null, scopes: ["root"], source: "session" })
        .success,
    ).toBe(false);
  });

  it("requires the dated fields on Org/User/Session/ApiToken rows", () => {
    const now = new Date();
    const validOrg = {
      id: "o",
      kind: "github_org" as const,
      externalId: "1",
      login: "acme",
      displayName: "Acme",
      createdAt: now,
      updatedAt: now,
    };
    expect(OrgSchema.safeParse(validOrg).success).toBe(true);
    // every id/login/externalId on Org carries `.min(1)`: empties are rejected.
    expect(OrgSchema.safeParse({ ...validOrg, id: "" }).success).toBe(false);
    expect(OrgSchema.safeParse({ ...validOrg, externalId: "" }).success).toBe(false);
    expect(OrgSchema.safeParse({ ...validOrg, login: "" }).success).toBe(false);
    const validUser = {
      id: "u",
      provider: "github_oauth" as const,
      providerSubject: "s",
      login: null,
      email: null,
      displayName: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(UserSchema.safeParse(validUser).success).toBe(true);
    // a string createdAt (not a Date) is rejected, and empty id/providerSubject too.
    expect(UserSchema.safeParse({ ...validUser, createdAt: "2026-01-01" }).success).toBe(false);
    expect(UserSchema.safeParse({ ...validUser, id: "" }).success).toBe(false);
    expect(UserSchema.safeParse({ ...validUser, providerSubject: "" }).success).toBe(false);

    const validSession = {
      id: "s",
      userId: "u",
      csrfToken: "csrf",
      expiresAt: now,
      createdAt: now,
      ip: null,
      userAgent: null,
    };
    expect(SessionSchema.safeParse(validSession).success).toBe(true);
    // session requires a non-empty csrf token + id + userId.
    expect(SessionSchema.safeParse({ ...validSession, csrfToken: "" }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...validSession, id: "" }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...validSession, userId: "" }).success).toBe(false);
    // api token requires a scopes array of valid members; expiresAt may be null.
    const validToken = {
      id: "t",
      userId: "u",
      name: "cli",
      tokenHash: "h",
      scopes: ["read"],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: now,
    };
    expect(ApiTokenSchema.safeParse(validToken).success).toBe(true);
    expect(ApiTokenSchema.safeParse({ ...validToken, scopes: ["bogus"] }).success).toBe(false);
    // id / userId / name / tokenHash all carry `.min(1)`.
    expect(ApiTokenSchema.safeParse({ ...validToken, tokenHash: "" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...validToken, userId: "" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...validToken, name: "" }).success).toBe(false);
  });
});
