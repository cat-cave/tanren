// Behavior-based mutation guards for the operator-auth IdentityProvider seam
// (test/mutation-ratchet-auth) — part 1 of 3: the github_oauth / generic OIDC /
// local_dev providers + IdentityProviderError. Every test drives a REAL mapped
// IdentityClaims (or accept/reject outcome) through an injected fetch stub; no
// network, no module mocking. Companion files: authStoreMutationGuards (identity
// store + env builders + schemas) and authMiddlewareMutationGuards (request
// middleware + cookies).

import { describe, expect, it } from "vitest";
import {
  GitHubOAuthProvider,
  IdentityProviderError,
  LocalDevProvider,
  OidcProvider,
  createDevLoginProvider,
  DEV_LOGIN_IDENTITY,
  type IdentityClaims,
} from "../src/auth/index.js";
import {
  jsonResponse,
  OIDC_DISCOVERY,
  OIDC_ISSUER,
  recordingFetch,
  type FetchCall,
} from "./helpers/authMutationHarness.js";

// =============================================================================
// OIDC provider: claim mapping + token/userinfo wire shape + error mapping
// =============================================================================

function driveOidc(
  userinfo: Record<string, unknown>,
  overrides: Partial<ConstructorParameters<typeof OidcProvider>[0]> = {},
) {
  const { fetchImpl, calls } = recordingFetch((call) => {
    if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse(OIDC_DISCOVERY);
    if (call.url === OIDC_DISCOVERY.token_endpoint) return jsonResponse({ access_token: "oidc_tok" });
    if (call.url === OIDC_DISCOVERY.userinfo_endpoint) return jsonResponse(userinfo);
    return new Response("not found", { status: 404 });
  });
  const provider = new OidcProvider({
    issuer: OIDC_ISSUER,
    clientId: "cid",
    clientSecret: "the_secret",
    fetchImpl,
    ...overrides,
  });
  return { provider, calls };
}

describe("OidcProvider claim-mapping + wire-shape guards", () => {
  it("falls back to login for displayName only when the name claim is absent", async () => {
    // mapClaims: displayName ?? login. Kills the `??` -> `&&` / drop mutants and
    // a swap of the displayName source claim.
    const withName = driveOidc({ sub: "s1", preferred_username: "octo", name: "Octo Display" });
    expect((await withName.provider.exchangeCode("c", "https://cb")).displayName).toBe("Octo Display");

    const withoutName = driveOidc({ sub: "s1", preferred_username: "octo" });
    const claims = await withoutName.provider.exchangeCode("c", "https://cb");
    expect(claims.displayName).toBe("octo");
    expect(claims.login).toBe("octo");
  });

  it("derives org login by lowercasing the group and preserves displayName/externalId casing", async () => {
    // mapOrgs: login = group.toLowerCase(); externalId/displayName keep raw case.
    // Kills toLowerCase drop and externalId<->login source swaps.
    const { provider } = driveOidc({ sub: "s1", groups: ["Platform-Admins"] });
    const claims = await provider.exchangeCode("c", "https://cb");
    expect(claims.orgs).toEqual([
      { externalId: "Platform-Admins", login: "platform-admins", displayName: "Platform-Admins", kind: "oidc" },
    ]);
  });

  it("skips empty-string and non-string group entries instead of emitting blank orgs", async () => {
    // mapOrgs: `group === null || group === ""` continue. Kills the boundary /
    // logical-operator mutants that would let an empty org through.
    const { provider } = driveOidc({ sub: "s1", groups: ["", "real", null, {}, "Second"] });
    const claims = await provider.exchangeCode("c", "https://cb");
    expect(claims.orgs.map((o) => o.externalId)).toEqual(["real", "Second"]);
  });

  it("returns no orgs when the groups claim is not an array", async () => {
    // mapOrgs: `if (!Array.isArray(raw)) return []`. Kills the negation/return.
    const { provider } = driveOidc({ sub: "s1", groups: "not-an-array" });
    expect((await provider.exchangeCode("c", "https://cb")).orgs).toEqual([]);
  });

  it("coerces a numeric subject claim to a string and rejects an empty-string subject", async () => {
    // stringClaim: numbers -> String(n); empty string -> null (missing subject).
    const numeric = driveOidc({ sub: 1234, preferred_username: "octo" });
    expect((await numeric.provider.exchangeCode("c", "https://cb")).providerSubject).toBe("1234");

    const empty = driveOidc({ sub: "", preferred_username: "octo" });
    await expect(empty.provider.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("posts the authorization_code grant with client credentials to the token endpoint", async () => {
    // fetchAccessToken body + method. Kills grant_type/method/field mutants.
    const { provider, calls } = driveOidc({ sub: "s1" });
    await provider.exchangeCode("the-code", "https://app/cb");
    const tokenCall = calls.find((c) => c.url === OIDC_DISCOVERY.token_endpoint);
    expect(tokenCall?.init?.method).toBe("POST");
    const body = String(tokenCall?.init?.body ?? "");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=the_secret");
    expect(body).toContain("redirect_uri=https%3A%2F%2Fapp%2Fcb");
  });

  it("sends the bearer access token (not the client secret) to userinfo", async () => {
    const { provider, calls } = driveOidc({ sub: "s1" });
    await provider.exchangeCode("c", "https://cb");
    const userinfoCall = calls.find((c) => c.url === OIDC_DISCOVERY.userinfo_endpoint);
    const headers = (userinfoCall?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer oidc_tok");
    expect(Object.values(headers).join(" ")).not.toContain("the_secret");
  });

  it("maps a token-endpoint error payload to a 400 IdentityProviderError", async () => {
    // fetchAccessToken: error -> 400 with error_description preferred.
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse(OIDC_DISCOVERY);
      if (call.url === OIDC_DISCOVERY.token_endpoint) {
        return jsonResponse({ error: "invalid_grant", error_description: "code expired" });
      }
      return new Response("nope", { status: 500 });
    });
    const provider = new OidcProvider({ issuer: OIDC_ISSUER, clientId: "c", clientSecret: "s", fetchImpl });
    await expect(provider.exchangeCode("bad", "https://cb")).rejects.toMatchObject({
      providerId: "oidc",
      statusCode: 400,
      message: expect.stringContaining("code expired"),
    });
  });

  it("raises when the token response is missing an access_token", async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse(OIDC_DISCOVERY);
      if (call.url === OIDC_DISCOVERY.token_endpoint) return jsonResponse({ token_type: "Bearer" });
      return new Response("x", { status: 500 });
    });
    const provider = new OidcProvider({ issuer: OIDC_ISSUER, clientId: "c", clientSecret: "s", fetchImpl });
    await expect(provider.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("raises a 502-class error when discovery is non-ok", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("down", { status: 503 }));
    const provider = new OidcProvider({ issuer: OIDC_ISSUER, clientId: "c", clientSecret: "s", fetchImpl });
    await expect(provider.exchangeCode("c", "https://cb")).rejects.toMatchObject({ statusCode: 502 });
  });

  it("caches discovery: a second exchange does not re-fetch the discovery document", async () => {
    // discover(): `this.discoveryCache ??= ...`. Kills the ??= -> = mutant.
    const { provider, calls } = driveOidc({ sub: "s1" });
    await provider.exchangeCode("c", "https://cb");
    await provider.exchangeCode("c", "https://cb");
    const discoveryHits = calls.filter((c) => c.url.endsWith("/.well-known/openid-configuration"));
    expect(discoveryHits).toHaveLength(1);
  });

  it("strips a trailing slash from the issuer when composing endpoints", () => {
    // constructor: issuer.replace(/\/$/,""). Authorize URL must not double-slash.
    const provider = new OidcProvider({ issuer: `${OIDC_ISSUER}/`, clientId: "cid", clientSecret: "s" });
    const url = provider.buildAuthorizeUrl("st", "https://cb");
    expect(url.startsWith(`${OIDC_ISSUER}/application/o/authorize/?`)).toBe(true);
    expect(url).not.toContain("//application");
  });

  it("requests the default OIDC scopes joined by spaces at authorize time", () => {
    const provider = new OidcProvider({ issuer: OIDC_ISSUER, clientId: "cid", clientSecret: "s" });
    const url = provider.buildAuthorizeUrl("st-1", "https://app/cb");
    expect(url).toContain("scope=openid+profile+email+groups");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=st-1");
  });

  it("raises when the discovery document is malformed (missing endpoints)", async () => {
    // fetchDiscovery `!parsed.success` -> throw. Kills the `if (false)` mutant.
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse({ issuer: OIDC_ISSUER });
      return new Response("x", { status: 500 });
    });
    const provider = new OidcProvider({ issuer: OIDC_ISSUER, clientId: "c", clientSecret: "s", fetchImpl });
    await expect(provider.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("raises when the userinfo endpoint is non-ok", async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return jsonResponse(OIDC_DISCOVERY);
      if (call.url === OIDC_DISCOVERY.token_endpoint) return jsonResponse({ access_token: "t" });
      return new Response("no", { status: 403 });
    });
    const provider = new OidcProvider({ issuer: OIDC_ISSUER, clientId: "c", clientSecret: "s", fetchImpl });
    await expect(provider.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("form-url-encodes the token request body", async () => {
    // fetchAccessToken Content-Type: application/x-www-form-urlencoded.
    const { provider, calls } = driveOidc({ sub: "s1" });
    await provider.exchangeCode("c", "https://cb");
    const tokenCall = calls.find((c) => c.url === OIDC_DISCOVERY.token_endpoint);
    const headers = (tokenCall?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });
});

// =============================================================================
// GitHub OAuth provider: claim merge precedence + org normalization
// =============================================================================

function driveGithub(parts: {
  user?: unknown;
  emails?: unknown;
  orgs?: unknown;
  emailsStatus?: number;
  orgsStatus?: number;
}) {
  const { fetchImpl, calls } = recordingFetch((call) => {
    if (call.url.includes("login/oauth/access_token")) return jsonResponse({ access_token: "ghs_tok" });
    if (call.url.endsWith("/user")) return jsonResponse(parts.user ?? { id: 1, login: "u" });
    if (call.url.endsWith("/user/emails")) {
      return parts.emailsStatus !== undefined
        ? new Response("no", { status: parts.emailsStatus })
        : jsonResponse(parts.emails ?? []);
    }
    if (call.url.endsWith("/user/orgs")) {
      return parts.orgsStatus !== undefined
        ? new Response("no", { status: parts.orgsStatus })
        : jsonResponse(parts.orgs ?? []);
    }
    return new Response("not found", { status: 404 });
  });
  const provider = new GitHubOAuthProvider({ clientId: "cid", clientSecret: "the_secret", fetchImpl });
  return { provider, calls };
}

describe("GitHubOAuthProvider claim-merge guards", () => {
  it("prefers the primary email over the first listed and over the /user email", async () => {
    // fetchPrimaryEmail: find(primary === true) ?? list[0]; exchangeCode email
    // precedence is emails-endpoint ?? user.email. Kills the precedence mutants.
    const { provider } = driveGithub({
      user: { id: 9, login: "octo", name: "Octo", email: "user-object@example.com" },
      emails: [
        { email: "secondary@example.com", primary: false },
        { email: "primary@example.com", primary: true },
      ],
    });
    expect((await provider.exchangeCode("c", "https://cb")).email).toBe("primary@example.com");
  });

  it("falls back to the /user email when the emails endpoint is non-ok", async () => {
    // fetchPrimaryEmail returns null on non-ok; exchangeCode then uses user.email.
    const { provider } = driveGithub({
      user: { id: 9, login: "octo", name: null, email: "fallback@example.com" },
      emailsStatus: 403,
    });
    const claims = await provider.exchangeCode("c", "https://cb");
    expect(claims.email).toBe("fallback@example.com");
    // name null -> displayName falls back to login.
    expect(claims.displayName).toBe("octo");
  });

  it("stringifies a numeric user id as the provider subject", async () => {
    const { provider } = driveGithub({ user: { id: 424242, login: "octo" } });
    expect((await provider.exchangeCode("c", "https://cb")).providerSubject).toBe("424242");
  });

  it("lowercases the org login but keeps the raw id and description as displayName", async () => {
    const { provider } = driveGithub({
      user: { id: 1, login: "u" },
      orgs: [{ id: 77, login: "Cat-Cave", description: "the cat cave" }],
    });
    const claims = await provider.exchangeCode("c", "https://cb");
    expect(claims.orgs).toEqual([
      { externalId: "77", login: "cat-cave", displayName: "the cat cave", kind: "github_org" },
    ]);
  });

  it("uses the org login as displayName when description is null", async () => {
    // fetchOrgs: displayName = description ?? login.
    const { provider } = driveGithub({
      user: { id: 1, login: "u" },
      orgs: [{ id: 5, login: "Acme", description: null }],
    });
    expect((await provider.exchangeCode("c", "https://cb")).orgs[0]?.displayName).toBe("Acme");
  });

  it("raises an IdentityProviderError when the orgs endpoint is non-ok", async () => {
    // fetchOrgs throws on non-ok (unlike emails, which is best-effort).
    const { provider } = driveGithub({ user: { id: 1, login: "u" }, orgsStatus: 500 });
    await expect(provider.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("does not leak the client secret to the GitHub API endpoints", async () => {
    const { provider, calls } = driveGithub({ user: { id: 1, login: "u" } });
    await provider.exchangeCode("c", "https://cb");
    for (const call of calls.filter((c) => !c.url.includes("login/oauth/access_token"))) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(Object.values(headers).join(" ")).not.toContain("the_secret");
    }
  });

  it("requests the default github scopes and disables signup at authorize time", () => {
    const provider = new GitHubOAuthProvider({ clientId: "cid", clientSecret: "s" });
    const url = provider.buildAuthorizeUrl("st", "https://app/cb");
    expect(url.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    expect(url).toContain("scope=read%3Auser+user%3Aemail+read%3Aorg");
    expect(url).toContain("allow_signup=false");
    expect(url).toContain("state=st");
  });

  it("exposes the github_oauth provider id", () => {
    // id field literal; kills the `id = ""` mutant.
    expect(new GitHubOAuthProvider({ clientId: "c", clientSecret: "s" }).id).toBe("github_oauth");
  });

  it("hits the default api.github.com base and the /user, /user/emails, /user/orgs paths", async () => {
    // apiBaseUrl default + trailing-slash trim + per-endpoint path composition.
    const { provider, calls } = driveGithub({ user: { id: 1, login: "u" } });
    await provider.exchangeCode("c", "https://cb");
    const apiUrls = calls.map((c) => c.url);
    expect(apiUrls).toContain("https://api.github.com/user");
    expect(apiUrls).toContain("https://api.github.com/user/emails");
    expect(apiUrls).toContain("https://api.github.com/user/orgs");
  });

  it("trims a trailing slash from a custom api base", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url });
      if (url.includes("login/oauth/access_token")) return jsonResponse({ access_token: "t" });
      if (url.endsWith("/user")) return jsonResponse({ id: 1, login: "u" });
      return jsonResponse([]);
    }) as typeof fetch;
    const provider = new GitHubOAuthProvider({
      clientId: "c",
      clientSecret: "s",
      apiBaseUrl: "https://ghe.internal/api/v3/",
      fetchImpl,
    });
    await provider.exchangeCode("c", "https://cb");
    expect(calls.map((c) => c.url)).toContain("https://ghe.internal/api/v3/user");
  });

  it("POSTs JSON to the token endpoint with the json Content-Type", async () => {
    // token-exchange method + Content-Type header.
    const { provider, calls } = driveGithub({ user: { id: 1, login: "u" } });
    await provider.exchangeCode("the-code", "https://cb");
    const tokenCall = calls.find((c) => c.url.includes("login/oauth/access_token"));
    expect(tokenCall?.init?.method).toBe("POST");
    const headers = (tokenCall?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(tokenCall?.init?.body ?? "{}"));
    expect(body.code).toBe("the-code");
    expect(body.client_id).toBe("cid");
  });

  it("raises when the token endpoint is non-ok", async () => {
    // fetchAccessToken `!response.ok` -> throw. Kills the `if (false)` mutant.
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.includes("login/oauth/access_token")) return new Response("bad", { status: 401 });
      return jsonResponse({});
    });
    const provider = new GitHubOAuthProvider({ clientId: "c", clientSecret: "s", fetchImpl });
    await expect(provider.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("maps a token-endpoint error payload to a 400 with the description preferred", async () => {
    // error !== undefined -> throw 400; error_description ?? error precedence.
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.includes("login/oauth/access_token")) {
        return jsonResponse({ error: "bad_verification_code", error_description: "the code is invalid" });
      }
      return new Response("x", { status: 500 });
    });
    const erroring = new GitHubOAuthProvider({ clientId: "c", clientSecret: "s", fetchImpl });
    await expect(erroring.exchangeCode("c", "https://cb")).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("the code is invalid"),
    });
  });

  it("raises when the /user endpoint is non-ok", async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.includes("login/oauth/access_token")) return jsonResponse({ access_token: "t" });
      if (call.url.endsWith("/user")) return new Response("no", { status: 404 });
      return jsonResponse([]);
    });
    const p = new GitHubOAuthProvider({ clientId: "c", clientSecret: "s", fetchImpl });
    await expect(p.exchangeCode("c", "https://cb")).rejects.toBeInstanceOf(IdentityProviderError);
  });
});

// =============================================================================
// IdentityProviderError: prefixed message + default status
// =============================================================================

describe("IdentityProviderError", () => {
  it("prefixes the message with the provider id and defaults to status 502", () => {
    const err = new IdentityProviderError("oidc", "boom");
    expect(err.message).toBe("[oidc] boom");
    expect(err.providerId).toBe("oidc");
    expect(err.statusCode).toBe(502);
  });

  it("honors an explicit status code override", () => {
    expect(new IdentityProviderError("github_oauth", "bad", 400).statusCode).toBe(400);
  });
});

// =============================================================================
// local_dev provider + dev-login identity
// =============================================================================

describe("LocalDevProvider + dev login", () => {
  const identity: IdentityClaims = {
    providerSubject: "s",
    login: "dev",
    email: null,
    displayName: "Dev",
    orgs: [],
  };

  it("returns the fixed identity for any code without touching the network", async () => {
    const provider = new LocalDevProvider({ identity });
    await expect(provider.exchangeCode("whatever", "https://cb")).resolves.toEqual(identity);
    expect(provider.id).toBe("local_dev");
  });

  it("builds an authorize URL that round-trips state and a fixed local-dev code", () => {
    const provider = new LocalDevProvider({ identity });
    const url = provider.buildAuthorizeUrl("st-9", "https://app/auth/callback");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBe("st-9");
    expect(parsed.searchParams.get("code")).toBe("local-dev");
  });

  it("uses an explicit authorizeRedirectPath when configured, ignoring the callback URL", () => {
    // buildAuthorizeUrl: config.authorizeRedirectPath ?? callback. Kills `??`.
    const provider = new LocalDevProvider({ identity, authorizeRedirectPath: "/fixed-path" });
    expect(provider.buildAuthorizeUrl("st", "https://app/auth/callback")).toBe("/fixed-path");
  });

  it("mints the synthetic dev identity with an admin-creating github_org claim", () => {
    const provider = createDevLoginProvider();
    expect(provider.id).toBe("local_dev");
    expect(DEV_LOGIN_IDENTITY.login).toBe("tanren-dev");
    expect(DEV_LOGIN_IDENTITY.orgs).toEqual([
      { externalId: "tanren-dev-org", login: "tanren-dev", displayName: "Tanren Dev", kind: "github_org" },
    ]);
  });
});
