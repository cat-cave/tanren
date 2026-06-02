// P3-0030: OIDC provider (Authentik first) unit tests. Deterministic — the
// discovery, token, and userinfo endpoints are all mocked via an injected
// fetch; no live IdP, no network, no DB.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOidcProviderFromEnv, IdentityProviderError, OidcProvider } from "../src/auth/index.js";
import { buildAuthFromEnv } from "../src/main.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

const ISSUER = "https://idp.example.com";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/application/o/authorize/`,
  token_endpoint: `${ISSUER}/application/o/token/`,
  userinfo_endpoint: `${ISSUER}/application/o/userinfo/`,
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function buildProvider(
  handler: (call: FetchCall) => Response | Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof OidcProvider>[0]> = {},
) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    const call = { url: typeof input === "string" ? input : input.toString(), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const provider = new OidcProvider({
    issuer: ISSUER,
    clientId: "client_id_value",
    clientSecret: "client_secret_value",
    fetchImpl,
    ...overrides,
  });
  return { provider, calls };
}

function discoveryResponse(): Response {
  return new Response(JSON.stringify(DISCOVERY), {
    headers: { "Content-Type": "application/json" },
  });
}

// A userinfo handler that returns a single `engineering` group (M3 test).
function engineeringUserinfo(call: FetchCall): Response | undefined {
  if (call.url.endsWith("/userinfo/")) {
    return new Response(JSON.stringify({ sub: "s", groups: ["engineering"] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return undefined;
}

describe("OidcProvider", () => {
  it("builds an authorize URL with response_type=code and the configured scopes/state", () => {
    const { provider } = buildProvider(() => new Response(null));
    const url = provider.buildAuthorizeUrl("the-state", "https://app.example.com/auth/callback?provider=oidc");
    expect(url.startsWith(`${ISSUER}/application/o/authorize/?`)).toBe(true);
    expect(url).toContain("client_id=client_id_value");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=the-state");
    expect(url).toContain("scope=openid+profile+email+groups");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback%3Fprovider%3Doidc");
  });

  it("exchanges a code via discovery -> token -> userinfo and maps claims", async () => {
    const { provider, calls } = buildProvider((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (call.url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "oidc_access_token", token_type: "Bearer" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url === DISCOVERY.userinfo_endpoint) {
        return new Response(
          JSON.stringify({
            sub: "subject-123",
            preferred_username: "OctoOidc",
            name: "Octo OIDC",
            email: "octo@example.com",
            groups: ["Platform-Admins", "engineering"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const claims = await provider.exchangeCode("the-code", "https://app.example.com/auth/callback?provider=oidc");
    expect(claims).toMatchObject({
      providerSubject: "subject-123",
      login: "OctoOidc",
      email: "octo@example.com",
      displayName: "Octo OIDC",
    });
    // M3: org externalId is namespaced by issuer so group names cannot collide
    // across IdPs; login/displayName remain the bare group name.
    expect(claims.orgs).toEqual([
      {
        externalId: `${ISSUER}#Platform-Admins`,
        login: "platform-admins",
        displayName: "Platform-Admins",
        kind: "oidc",
      },
      { externalId: `${ISSUER}#engineering`, login: "engineering", displayName: "engineering", kind: "oidc" },
    ]);

    const tokenCall = calls.find((c) => c.url === DISCOVERY.token_endpoint);
    expect(tokenCall).toBeDefined();
    const tokenBody = String(tokenCall?.init?.body ?? "");
    expect(tokenBody).toContain("grant_type=authorization_code");
    expect(tokenBody).toContain("code=the-code");
  });

  it("does not send the client secret to the userinfo endpoint", async () => {
    const { provider, calls } = buildProvider((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (call.url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sub: "s1" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    await provider.exchangeCode("c", "https://app.example.com/cb");
    const userinfoCall = calls.find((c) => c.url === DISCOVERY.userinfo_endpoint);
    const headers = (userinfoCall?.init?.headers ?? {}) as Record<string, string>;
    expect(Object.values(headers).join(" ")).not.toContain("client_secret_value");
    expect(userinfoCall?.url).not.toContain("client_secret_value");
  });

  it("honors custom subject/login/groups claim overrides", async () => {
    const { provider } = buildProvider(
      (call) => {
        if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
        if (call.url === DISCOVERY.token_endpoint) {
          return new Response(JSON.stringify({ access_token: "tok" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ oid: "oid-9", uname: "custom-user", teams: ["alpha"] }), {
          headers: { "Content-Type": "application/json" },
        });
      },
      { subjectClaim: "oid", loginClaim: "uname", groupsClaim: "teams" },
    );
    const claims = await provider.exchangeCode("c", "https://app.example.com/cb");
    expect(claims.providerSubject).toBe("oid-9");
    expect(claims.login).toBe("custom-user");
    expect(claims.orgs).toEqual([
      { externalId: `${ISSUER}#alpha`, login: "alpha", displayName: "alpha", kind: "oidc" },
    ]);
  });

  it("M3: a same-named group from two different issuers maps to DISTINCT external ids", async () => {
    const issuerB = "https://other-idp.example.com";
    const discoveryB = {
      issuer: issuerB,
      authorization_endpoint: `${issuerB}/application/o/authorize/`,
      token_endpoint: `${issuerB}/application/o/token/`,
      userinfo_endpoint: `${issuerB}/application/o/userinfo/`,
    };
    const { provider: providerA } = buildProvider((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (call.url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return engineeringUserinfo(call) ?? new Response("not found", { status: 404 });
    });
    const { provider: providerB } = buildProvider(
      (call) => {
        if (call.url.endsWith("/.well-known/openid-configuration")) {
          return new Response(JSON.stringify(discoveryB), { headers: { "Content-Type": "application/json" } });
        }
        if (call.url === discoveryB.token_endpoint) {
          return new Response(JSON.stringify({ access_token: "tok" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return engineeringUserinfo(call) ?? new Response("not found", { status: 404 });
      },
      { issuer: issuerB },
    );

    const claimsA = await providerA.exchangeCode("c", "https://app.example.com/cb");
    const claimsB = await providerB.exchangeCode("c", "https://app.example.com/cb");
    expect(claimsA.orgs[0]?.externalId).toBe(`${ISSUER}#engineering`);
    expect(claimsB.orgs[0]?.externalId).toBe(`${issuerB}#engineering`);
    // The collision is gone: distinct issuers → distinct `(kind, external_id)`
    // keys → distinct Tanren orgs (no cross-IdP group-name squatting).
    expect(claimsA.orgs[0]?.externalId).not.toBe(claimsB.orgs[0]?.externalId);
  });

  it("raises IdentityProviderError when the token endpoint returns an error payload", async () => {
    const { provider } = buildProvider((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (call.url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    });
    await expect(provider.exchangeCode("bad", "https://app.example.com/cb")).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
  });

  it("raises IdentityProviderError when userinfo lacks the subject claim", async () => {
    const { provider } = buildProvider((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (call.url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ name: "no subject here" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    await expect(provider.exchangeCode("c", "https://app.example.com/cb")).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
  });
});

describe("buildOidcProviderFromEnv", () => {
  const KEYS = [
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
  const SAVED: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      SAVED[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
    }
  });

  it("returns undefined when OIDC env is unset", () => {
    expect(buildOidcProviderFromEnv()).toBeUndefined();
  });

  it("returns undefined when issuer is set but client id/secret are missing", () => {
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    expect(buildOidcProviderFromEnv()).toBeUndefined();
  });

  it("builds an OidcProvider when issuer + client id/secret are all set", () => {
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    const provider = buildOidcProviderFromEnv();
    expect(provider).toBeInstanceOf(OidcProvider);
    expect(provider?.id).toBe("oidc");
  });

  it("buildAuthFromEnv registers oidc only when configured, alongside github_oauth", () => {
    const githubKeys = ["TANREN_GITHUB_OAUTH_CLIENT_ID", "TANREN_GITHUB_OAUTH_CLIENT_SECRET"] as const;
    const savedGithub = githubKeys.map((k) => [k, process.env[k]] as const);
    try {
      process.env.TANREN_GITHUB_OAUTH_CLIENT_ID = "gh_id";
      process.env.TANREN_GITHUB_OAUTH_CLIENT_SECRET = "gh_secret";

      // Without OIDC env: github_oauth present, oidc absent.
      const without = buildAuthFromEnv(createFakeIdentityPool().asPgPool());
      expect(without?.providers.has("github_oauth")).toBe(true);
      expect(without?.providers.has("oidc")).toBe(false);

      // With OIDC env: both registered.
      process.env.TANREN_OIDC_ISSUER = ISSUER;
      process.env.TANREN_OIDC_CLIENT_ID = "cid";
      process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
      const withOidc = buildAuthFromEnv(createFakeIdentityPool().asPgPool());
      expect(withOidc?.providers.has("github_oauth")).toBe(true);
      expect(withOidc?.providers.has("oidc")).toBe(true);
      expect(withOidc?.providers.get("oidc")?.id).toBe("oidc");
    } finally {
      for (const [k, v] of savedGithub) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
