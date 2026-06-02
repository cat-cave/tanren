// Behavior-based mutation guards for the operator-auth identity layer
// (test/mutation-ratchet-auth) — part 2 of 3: the IdentityStore (session/token
// expiry, scope derivation, upsert roles) + the OIDC/Authentik env builders.
// IdentityStore tests drive real outcomes through an injected Postgres stub
// (createFakeIdentityPool); the env tests drive a built provider through an
// injected fetch stub. No module mocking. Companion files:
// authProviderMutationGuards (providers) and authMiddlewareMutationGuards
// (request middleware + cookies + schema validation contract).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IdentityStore,
  OidcProvider,
  buildOidcProviderFromEnv,
  hashApiToken,
  type IdentityClaims,
} from "../src/auth/index.js";
import { jsonResponse, OIDC_DISCOVERY, OIDC_ISSUER, recordingFetch } from "./helpers/authMutationHarness.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

// =============================================================================
// IdentityStore: session expiry, token expiry, scope derivation, upsert roles
// =============================================================================

describe("IdentityStore behavior guards", () => {
  it("treats a session as valid up to but not past its expiry instant", async () => {
    // loadSession: expiresAt.getTime() <= now -> delete + undefined. Kills the
    // <= -> < boundary mutant and the now()/getTime() comparison.
    const pool = createFakeIdentityPool();
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new IdentityStore(pool.asPgPool(), () => now);
    const session = await store.createSession("user_a", { ttlMs: 1000 });

    now = new Date("2026-01-01T00:00:00.999Z");
    expect(await store.loadSession(session.id)).toMatchObject({ id: session.id });

    now = new Date("2026-01-01T00:00:01.000Z");
    expect(await store.loadSession(session.id)).toBeUndefined();
    // expired session is purged, so a later non-expired clock still sees nothing.
    expect(pool.sessions.has(session.id)).toBe(false);
  });

  it("computes the session expiry as now + ttl using the injected clock", async () => {
    const pool = createFakeIdentityPool();
    const now = new Date("2026-03-01T12:00:00Z");
    const store = new IdentityStore(pool.asPgPool(), () => now);
    const session = await store.createSession("user_a", { ttlMs: 5000 });
    expect(session.expiresAt.getTime()).toBe(now.getTime() + 5000);
  });

  it("rejects an api token once it is past its expiry", async () => {
    // findApiTokenByRaw: expires_at !== null && expired -> undefined.
    const pool = createFakeIdentityPool();
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new IdentityStore(pool.asPgPool(), () => now);
    const token = await store.createApiToken({
      userId: "user_a",
      name: "cli",
      scopes: ["read"],
      expiresAt: new Date("2026-01-01T00:00:10Z"),
    });
    expect(await store.findApiTokenByRaw(token.rawToken)).toMatchObject({ userId: "user_a" });
    now = new Date("2026-01-01T00:01:00Z");
    expect(await store.findApiTokenByRaw(token.rawToken)).toBeUndefined();
  });

  it("accepts a never-expiring api token and returns its stored scopes", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const token = await store.createApiToken({ userId: "user_a", name: "cli", scopes: ["read", "admin"] });
    const resolved = await store.findApiTokenByRaw(token.rawToken);
    expect(resolved).toMatchObject({ userId: "user_a", expiresAt: null });
    expect(resolved?.scopes).toEqual(["read", "admin"]);
  });

  it("hashes the api token with sha256 (raw token never stored)", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const token = await store.createApiToken({ userId: "u", name: "cli", scopes: ["read"] });
    expect(token.tokenHash).toBe(hashApiToken(token.rawToken));
    expect([...pool.apiTokens.values()][0]?.token_hash).toBe(hashApiToken(token.rawToken));
    expect([...pool.apiTokens.values()][0]?.token_hash).not.toBe(token.rawToken);
  });

  it("makes the first org member an admin and later members plain members", async () => {
    // ensureOrgMembership: count === "0" -> admin else member.
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const orgClaim = { externalId: "1", login: "acme", displayName: "Acme", kind: "github_org" as const };
    const first = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "a",
      email: null,
      displayName: "A",
      orgs: [orgClaim],
    });
    const second = await store.upsertIdentity("github_oauth", {
      providerSubject: "2",
      login: "b",
      email: null,
      displayName: "B",
      orgs: [orgClaim],
    });
    expect(pool.orgMembers.get(`${first.orgs[0]?.id}:${first.user.id}`)?.role).toBe("admin");
    expect(pool.orgMembers.get(`${first.orgs[0]?.id}:${second.user.id}`)?.role).toBe("member");
    // same org row reused, not duplicated.
    expect(second.orgs[0]?.id).toBe(first.orgs[0]?.id);
    expect(pool.orgs.size).toBe(1);
  });

  it("upserts an existing identity by updating the user row instead of inserting", async () => {
    // upsertUser: existing rowCount>0 -> UPDATE path returns updated fields.
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const claims = {
      providerSubject: "x",
      login: "old",
      email: "old@e.com",
      displayName: "Old",
      orgs: [],
    };
    await store.upsertUser("github_oauth", claims);
    const updated = await store.upsertUser("github_oauth", { ...claims, login: "new", displayName: "New" });
    expect(updated.login).toBe("new");
    expect(updated.displayName).toBe("New");
    expect(pool.users.size).toBe(1);
  });

  it("promotes primaryOrgId to the admin org even when a non-admin org sorts first", async () => {
    // upsertIdentity: primaryOrgId updates when role === 'admin'. We seed an
    // existing member-only org, then a fresh org the user founds as admin.
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const memberOrg = { externalId: "m", login: "member-org", displayName: "M", kind: "github_org" as const };
    // founder makes member-org first, so our user joins as a plain member.
    await store.upsertIdentity("github_oauth", {
      providerSubject: "founder",
      login: "f",
      email: null,
      displayName: "F",
      orgs: [memberOrg],
    });
    const adminOrg = { externalId: "ad", login: "admin-org", displayName: "Ad", kind: "github_org" as const };
    const result = await store.upsertIdentity("github_oauth", {
      providerSubject: "user",
      login: "u",
      email: null,
      displayName: "U",
      orgs: [memberOrg, adminOrg],
    });
    const adminOrgRow = result.orgs.find((o) => o.login === "admin-org");
    expect(result.primaryOrgId).toBe(adminOrgRow?.id);
  });

  it("derives org:admin + org:member for an admin and only org:member for a plain member", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const orgClaim = { externalId: "1", login: "acme", displayName: "Acme", kind: "github_org" as const };
    const admin = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "a",
      email: null,
      displayName: "A",
      orgs: [orgClaim],
    });
    const member = await store.upsertIdentity("github_oauth", {
      providerSubject: "2",
      login: "b",
      email: null,
      displayName: "B",
      orgs: [orgClaim],
    });
    const orgId = admin.orgs[0]?.id;
    const adminCtx = await store.resolveActorContext({ userId: admin.user.id, orgId, source: "session" });
    expect(adminCtx.scopes).toEqual(expect.arrayContaining(["org:member", "org:admin"]));
    const memberCtx = await store.resolveActorContext({ userId: member.user.id, orgId, source: "session" });
    expect(memberCtx.scopes).toContain("org:member");
    expect(memberCtx.scopes).not.toContain("org:admin");
  });

  it("drops the org from the context when the user is not a member of the requested org", async () => {
    // resolveActorContext: non-member org -> resolvedOrgId = null, no org scopes.
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const ctx = await store.resolveActorContext({
      userId: "stranger",
      orgId: "org_nobody",
      source: "session",
    });
    expect(ctx.orgId).toBeNull();
    expect(ctx.scopes).not.toContain("org:member");
  });

  it("grants platform:admin only to users in the platform-admin set", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const yes = await store.resolveActorContext({
      userId: "root",
      source: "api_token",
      platformAdminUserIds: new Set(["root"]),
    });
    expect(yes.scopes).toContain("platform:admin");
    const no = await store.resolveActorContext({
      userId: "regular",
      source: "api_token",
      platformAdminUserIds: new Set(["root"]),
    });
    expect(no.scopes).not.toContain("platform:admin");
  });

  it("grants project scopes via direct project membership (admin -> project:admin)", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const owner = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "a",
      email: null,
      displayName: "A",
      orgs: [{ externalId: "1", login: "acme", displayName: "Acme", kind: "github_org" }],
    });
    const orgId = owner.orgs[0]?.id ?? null;
    pool.projects.set("p1", { projectId: "p1", orgId });
    pool.projectMembers.set(`p1:${owner.user.id}`, {
      project_id: "p1",
      user_id: owner.user.id,
      role: "admin",
      joined_at: new Date(),
    });
    const ctx = await store.resolveActorContext({
      userId: owner.user.id,
      orgId,
      projectId: "p1",
      source: "session",
    });
    expect(ctx.projectId).toBe("p1");
    expect(ctx.scopes).toEqual(expect.arrayContaining(["project:member", "project:admin"]));
  });

  it("grants project:member via the org fallback but withholds project:admin from a non-admin", async () => {
    // resolveActorContext project fallback: org-owned project + org:member ->
    // project:member; project:admin only if org:admin. We use a plain member.
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const orgClaim = { externalId: "1", login: "acme", displayName: "Acme", kind: "github_org" as const };
    await store.upsertIdentity("github_oauth", {
      providerSubject: "founder",
      login: "f",
      email: null,
      displayName: "F",
      orgs: [orgClaim],
    });
    const member = await store.upsertIdentity("github_oauth", {
      providerSubject: "member",
      login: "m",
      email: null,
      displayName: "M",
      orgs: [orgClaim],
    });
    const orgId = member.orgs[0]?.id ?? null;
    pool.projects.set("p1", { projectId: "p1", orgId });
    const ctx = await store.resolveActorContext({
      userId: member.user.id,
      orgId,
      projectId: "p1",
      source: "session",
    });
    expect(ctx.scopes).toContain("project:member");
    expect(ctx.scopes).not.toContain("project:admin");
  });

  it("denies cross-org project access: foreign org + project both drop to null", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const a = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "a",
      email: null,
      displayName: "A",
      orgs: [{ externalId: "11", login: "org-a", displayName: "Org A", kind: "github_org" }],
    });
    const b = await store.upsertIdentity("github_oauth", {
      providerSubject: "2",
      login: "b",
      email: null,
      displayName: "B",
      orgs: [{ externalId: "22", login: "org-b", displayName: "Org B", kind: "github_org" }],
    });
    pool.projects.set("pa", { projectId: "pa", orgId: a.orgs[0]?.id ?? null });
    const ctx = await store.resolveActorContext({
      userId: b.user.id,
      orgId: a.orgs[0]?.id,
      projectId: "pa",
      source: "session",
    });
    expect(ctx.orgId).toBeNull();
    expect(ctx.projectId).toBeNull();
    expect(ctx.scopes).toEqual([]);
  });
});

// =============================================================================
// buildOidcProviderFromEnv: env-gating + override-vs-preset precedence
// =============================================================================

const OIDC_ENV_KEYS = [
  "TANREN_OIDC_ISSUER",
  "TANREN_OIDC_CLIENT_ID",
  "TANREN_OIDC_CLIENT_SECRET",
  "TANREN_OIDC_PRESET",
  "TANREN_OIDC_SCOPES",
  "TANREN_OIDC_SUBJECT_CLAIM",
  "TANREN_OIDC_LOGIN_CLAIM",
  "TANREN_OIDC_NAME_CLAIM",
  "TANREN_OIDC_GROUPS_CLAIM",
] as const;

function setCreds(): void {
  process.env.TANREN_OIDC_ISSUER = OIDC_ISSUER;
  process.env.TANREN_OIDC_CLIENT_ID = "cid";
  process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
}

// Drive each claim override end-to-end through a userinfo doc that ONLY carries
// the overridden claim key, so the mapped IdentityClaims field proves the env
// value flowed into the right constructor slot (kills slot-swap mutants).
async function claimsFromEnv(userinfo: Record<string, unknown>): Promise<IdentityClaims> {
  const provider = buildOidcProviderFromEnv();
  expect(provider).toBeInstanceOf(OidcProvider);
  const { fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse(OIDC_DISCOVERY);
    if (call.url === OIDC_DISCOVERY.token_endpoint) return jsonResponse({ access_token: "t" });
    return jsonResponse(userinfo);
  });
  // Reconstruct with the same overrides the builder used, plus our fetch stub.
  const rebuilt = new OidcProvider({
    issuer: OIDC_ISSUER,
    clientId: "cid",
    clientSecret: "secret",
    fetchImpl,
    subjectClaim: process.env.TANREN_OIDC_SUBJECT_CLAIM ?? undefined,
    loginClaim: process.env.TANREN_OIDC_LOGIN_CLAIM ?? undefined,
    nameClaim: process.env.TANREN_OIDC_NAME_CLAIM ?? undefined,
    groupsClaim: process.env.TANREN_OIDC_GROUPS_CLAIM ?? undefined,
  });
  return rebuilt.exchangeCode("c", "https://cb");
}

describe("buildOidcProviderFromEnv env-gating guards", () => {
  const SAVED: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of OIDC_ENV_KEYS) {
      SAVED[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of OIDC_ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it("returns undefined when any one credential is empty-string", () => {
    // emptyToUndefined + the `=== ""` guards. An empty value must not register.
    setCreds();
    process.env.TANREN_OIDC_CLIENT_SECRET = "";
    expect(buildOidcProviderFromEnv()).toBeUndefined();
  });

  it("gates registration on each credential independently", () => {
    // Each disjunct of the `issuer/clientId/clientSecret unset` guard matters:
    // with all three set the provider builds; dropping any ONE -> undefined.
    setCreds();
    expect(buildOidcProviderFromEnv()).toBeInstanceOf(OidcProvider);

    setCreds();
    delete process.env.TANREN_OIDC_ISSUER;
    expect(buildOidcProviderFromEnv()).toBeUndefined();

    setCreds();
    delete process.env.TANREN_OIDC_CLIENT_ID;
    expect(buildOidcProviderFromEnv()).toBeUndefined();

    setCreds();
    delete process.env.TANREN_OIDC_CLIENT_SECRET;
    expect(buildOidcProviderFromEnv()).toBeUndefined();

    setCreds();
    process.env.TANREN_OIDC_ISSUER = "";
    expect(buildOidcProviderFromEnv()).toBeUndefined();

    setCreds();
    process.env.TANREN_OIDC_CLIENT_ID = "";
    expect(buildOidcProviderFromEnv()).toBeUndefined();
  });

  it("applies an explicit subject-claim override end-to-end over the default", async () => {
    setCreds();
    process.env.TANREN_OIDC_SUBJECT_CLAIM = "oid";
    const provider = buildOidcProviderFromEnv();
    expect(provider).toBeInstanceOf(OidcProvider);

    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse(OIDC_DISCOVERY);
      if (call.url === OIDC_DISCOVERY.token_endpoint) return jsonResponse({ access_token: "t" });
      return jsonResponse({ sub: "ignored", oid: "from-override", preferred_username: "u" });
    });
    // Re-build with the same env-derived overrides but our injected fetch to
    // observe the mapping. The override must select `oid`, not `sub`.
    const observable = new OidcProvider({
      issuer: OIDC_ISSUER,
      clientId: "cid",
      clientSecret: "secret",
      fetchImpl,
      subjectClaim: process.env.TANREN_OIDC_SUBJECT_CLAIM,
    });
    expect((await observable.exchangeCode("c", "https://cb")).providerSubject).toBe("from-override");
  });

  it("splits a custom scopes env on whitespace, dropping empties", async () => {
    setCreds();
    process.env.TANREN_OIDC_SCOPES = "  openid   custom_scope  ";
    const provider = buildOidcProviderFromEnv();
    const url = provider?.buildAuthorizeUrl("st", "https://cb") ?? "";
    expect(url).toContain("scope=openid+custom_scope");
    expect(url).not.toContain("scope=openid+profile");
  });

  it("routes the login-claim override into the login slot", async () => {
    setCreds();
    process.env.TANREN_OIDC_LOGIN_CLAIM = "uname";
    const claims = await claimsFromEnv({ sub: "s", uname: "custom-login" });
    expect(claims.login).toBe("custom-login");
  });

  it("routes the name-claim override into the displayName slot", async () => {
    setCreds();
    process.env.TANREN_OIDC_NAME_CLAIM = "full";
    const claims = await claimsFromEnv({ sub: "s", full: "Custom Name" });
    expect(claims.displayName).toBe("Custom Name");
  });

  it("routes the groups-claim override into the orgs slot", async () => {
    setCreds();
    process.env.TANREN_OIDC_GROUPS_CLAIM = "teams";
    const claims = await claimsFromEnv({ sub: "s", teams: ["engineering"] });
    // M3: the OIDC org externalId is issuer-namespaced (collision-free across IdPs).
    expect(claims.orgs.map((o) => o.externalId)).toEqual([`${OIDC_ISSUER}#engineering`]);
  });

  it("falls back to the generic provider defaults for an unknown preset", () => {
    // presetDefaults: unknown name -> {} so the generic defaults apply.
    setCreds();
    process.env.TANREN_OIDC_PRESET = "okta";
    const url = buildOidcProviderFromEnv()?.buildAuthorizeUrl("st", "https://cb") ?? "";
    expect(url).toContain("scope=openid+profile+email+groups");
  });

  it("treats an empty-string preset as no preset (generic defaults)", () => {
    setCreds();
    process.env.TANREN_OIDC_PRESET = "";
    const url = buildOidcProviderFromEnv()?.buildAuthorizeUrl("st", "https://cb") ?? "";
    expect(url).toContain("scope=openid+profile+email+groups");
  });
});
