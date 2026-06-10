// Authentik OIDC preset (turnkey homelab) unit tests. Deterministic — no live
// IdP, no network, no DB. Covers two contracts:
//   1. the preset maps Authentik's standard userinfo claims
//      (`preferred_username` -> login, `groups` -> orgs, `name` -> display name)
//      onto IdentityClaims via the provider it configures, and
//   2. `TANREN_OIDC_PRESET=authentik` is threaded through buildOidcProviderFromEnv
//      / buildAuthFromEnv so the provider registers only when fully configured,
//      while explicit TANREN_OIDC_* overrides still win over preset defaults.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHENTIK_CLAIM_DEFAULTS,
  AUTHENTIK_SCOPES,
  OidcProvider,
  authentikPresetDefaults,
  buildOidcProviderFromEnv,
} from "../src/auth/index.js";
import { buildAuthFromEnv } from "../src/main.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

const ISSUER = "https://authentik.example.com/application/o/tanren";
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

/** Build a provider from the preset defaults with all network calls mocked. */
function presetProvider(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    const call = { url: typeof input === "string" ? input : input.toString(), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const provider = new OidcProvider({
    issuer: ISSUER,
    clientId: "cid",
    clientSecret: "secret",
    fetchImpl,
    ...authentikPresetDefaults(),
  });
  return { provider, calls };
}

function discoveryResponse(): Response {
  return new Response(JSON.stringify(DISCOVERY), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("authentik preset defaults", () => {
  it("pins Authentik's standard claim-mapping shape", () => {
    const defaults = authentikPresetDefaults();
    expect(defaults.subjectClaim).toBe("sub");
    expect(defaults.loginClaim).toBe("preferred_username");
    expect(defaults.nameClaim).toBe("name");
    expect(defaults.groupsClaim).toBe("groups");
    expect(defaults.scopes).toEqual(["openid", "profile", "email", "groups"]);
    // Exported constants and the partial-config helper agree.
    expect(defaults.subjectClaim).toBe(AUTHENTIK_CLAIM_DEFAULTS.subjectClaim);
    expect(defaults.loginClaim).toBe(AUTHENTIK_CLAIM_DEFAULTS.loginClaim);
    expect(defaults.scopes).toEqual([...AUTHENTIK_SCOPES]);
  });

  it("returns a fresh scopes array each call (no shared mutable state)", () => {
    const a = authentikPresetDefaults();
    const b = authentikPresetDefaults();
    expect(a.scopes).not.toBe(b.scopes);
    expect(a.scopes).toEqual(b.scopes);
  });

  it("maps Authentik userinfo (preferred_username/name/email/groups) onto IdentityClaims", async () => {
    const { provider } = presetProvider((call) => {
      if (call.url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (call.url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "tok", token_type: "Bearer" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url === DISCOVERY.userinfo_endpoint) {
        return new Response(
          JSON.stringify({
            sub: "ak-uuid-42",
            preferred_username: "homelab.admin",
            name: "Homelab Admin",
            email: "admin@home.lan",
            groups: ["Platform-Admins", "tanren-users"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const claims = await provider.exchangeCode("code", `${ISSUER}/auth/callback?provider=oidc`);
    expect(claims).toMatchObject({
      providerSubject: "ak-uuid-42",
      login: "homelab.admin",
      email: "admin@home.lan",
      displayName: "Homelab Admin",
    });
    // M3: org externalId is issuer-namespaced (collision-free across IdPs).
    expect(claims.orgs).toEqual([
      {
        externalId: `${ISSUER}#Platform-Admins`,
        login: "platform-admins",
        displayName: "Platform-Admins",
        kind: "oidc",
      },
      {
        externalId: `${ISSUER}#tanren-users`,
        login: "tanren-users",
        displayName: "tanren-users",
        kind: "oidc",
      },
    ]);
  });

  it("requests the Authentik scopes (incl. groups) at authorize time", () => {
    const { provider } = presetProvider(() => new Response(null));
    const url = provider.buildAuthorizeUrl("state-1", `${ISSUER}/auth/callback?provider=oidc`);
    expect(url).toContain("scope=openid+profile+email+groups");
  });
});

describe("buildOidcProviderFromEnv with TANREN_OIDC_PRESET=authentik", () => {
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
      const saved = SAVED[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it("disabled when only the preset is set; THROWS once a mandatory cred is partial", () => {
    // The preset is an OPTIONAL override; with NO mandatory creds (issuer/client
    // id/secret) OIDC is fully-absent → disabled (no throw), the legitimate
    // "preset declared but unused" case.
    process.env.TANREN_OIDC_PRESET = "authentik";
    expect(buildOidcProviderFromEnv()).toBeUndefined();

    // Adding ONLY the issuer makes it PARTIALLY configured (missing client
    // id/secret) → a LOUD boot error (Codex r5 §1), never a silent disable.
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    expect(() => buildOidcProviderFromEnv()).toThrow(/PARTIALLY configured/su);
  });

  it("builds an OidcProvider when the preset + issuer + client id/secret are set", () => {
    process.env.TANREN_OIDC_PRESET = "authentik";
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    const provider = buildOidcProviderFromEnv();
    expect(provider).toBeInstanceOf(OidcProvider);
    expect(provider?.id).toBe("oidc");
  });

  it("is case-insensitive on the preset name", () => {
    process.env.TANREN_OIDC_PRESET = "Authentik";
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    expect(buildOidcProviderFromEnv()).toBeInstanceOf(OidcProvider);
  });

  it("preset maps Authentik claims end-to-end, while an explicit env override still wins", async () => {
    process.env.TANREN_OIDC_PRESET = "authentik";
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    // Override only the groups claim; everything else falls back to the preset.
    process.env.TANREN_OIDC_GROUPS_CLAIM = "teams";

    const provider = buildOidcProviderFromEnv();
    expect(provider).toBeInstanceOf(OidcProvider);

    // Re-drive the same provider against a mocked Authentik to confirm the
    // preset login/name mapping plus the env-overridden groups claim.
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url });
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          sub: "ak-1",
          preferred_username: "alice",
          name: "Alice",
          email: "alice@home.lan",
          // preset would read `groups`, but the override points at `teams`:
          groups: ["ignored"],
          teams: ["engineering"],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const overridden = new OidcProvider({
      issuer: ISSUER,
      clientId: "cid",
      clientSecret: "secret",
      fetchImpl,
      ...authentikPresetDefaults(),
      groupsClaim: "teams",
    });
    const claims = await overridden.exchangeCode("c", `${ISSUER}/auth/callback?provider=oidc`);
    expect(claims.login).toBe("alice");
    expect(claims.displayName).toBe("Alice");
    expect(claims.orgs).toEqual([
      { externalId: `${ISSUER}#engineering`, login: "engineering", displayName: "engineering", kind: "oidc" },
    ]);
  });

  it("FAILS LOUD on an unknown preset (a typo must not silently run generic OIDC)", () => {
    // Code-integrity r3 (finding #3): a present-but-unknown TANREN_OIDC_PRESET is a typo —
    // it must throw, naming the value + the allowed set, NOT fall through to the generic
    // provider's (different) claim mapping. Creds are set so the throw is the preset, not creds.
    // "authentic" is a misspelling of the known "authentik" preset.
    process.env.TANREN_OIDC_PRESET = "authentic";
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    expect(() => buildOidcProviderFromEnv()).toThrow(/TANREN_OIDC_PRESET='authentic' is not a known OIDC preset/u);
  });

  it("UNSET preset → the generic-OIDC default (no preset, the documented behavior)", () => {
    // No TANREN_OIDC_PRESET. The provider still registers (creds present) and uses the
    // generic provider defaults — unset is NOT an error, only a present-yet-unknown value is.
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    expect(buildOidcProviderFromEnv()).toBeInstanceOf(OidcProvider);
  });

  it("a KNOWN preset → its claim mapping (authentik scopes incl. groups)", () => {
    process.env.TANREN_OIDC_PRESET = "authentik";
    process.env.TANREN_OIDC_ISSUER = ISSUER;
    process.env.TANREN_OIDC_CLIENT_ID = "cid";
    process.env.TANREN_OIDC_CLIENT_SECRET = "secret";
    const provider = buildOidcProviderFromEnv();
    const url = provider?.buildAuthorizeUrl("s", `${ISSUER}/auth/callback?provider=oidc`);
    expect(url).toContain("scope=openid+profile+email+groups");
  });

  it("buildAuthFromEnv registers oidc via the preset, alongside github_oauth", () => {
    const githubKeys = ["TANREN_GITHUB_OAUTH_CLIENT_ID", "TANREN_GITHUB_OAUTH_CLIENT_SECRET"] as const;
    const savedGithub = githubKeys.map((k) => [k, process.env[k]] as const);
    try {
      process.env.TANREN_GITHUB_OAUTH_CLIENT_ID = "gh_id";
      process.env.TANREN_GITHUB_OAUTH_CLIENT_SECRET = "gh_secret";
      process.env.TANREN_OIDC_PRESET = "authentik";
      process.env.TANREN_OIDC_ISSUER = ISSUER;
      process.env.TANREN_OIDC_CLIENT_ID = "cid";
      process.env.TANREN_OIDC_CLIENT_SECRET = "secret";

      const auth = buildAuthFromEnv(createFakeIdentityPool().asPgPool());
      expect(auth?.providers.has("github_oauth")).toBe(true);
      expect(auth?.providers.has("oidc")).toBe(true);
      expect(auth?.providers.get("oidc")?.id).toBe("oidc");
    } finally {
      for (const [k, v] of savedGithub) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
