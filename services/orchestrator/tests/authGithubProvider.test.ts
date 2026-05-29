import { describe, expect, it } from "vitest";
import { GitHubOAuthProvider, IdentityProviderError } from "../src/auth/index.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function buildProvider(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    const call = { url: typeof input === "string" ? input : input.toString(), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const provider = new GitHubOAuthProvider({
    clientId: "client_id_value",
    clientSecret: "client_secret_value",
    fetchImpl,
  });
  return { provider, calls };
}

describe("GitHubOAuthProvider", () => {
  it("builds an authorize URL with the configured scopes and state", () => {
    const { provider } = buildProvider(() => new Response(null));
    const url = provider.buildAuthorizeUrl("the-state", "https://app.example.com/auth/callback?provider=github_oauth");
    expect(url).toContain("client_id=client_id_value");
    expect(url).toContain("state=the-state");
    expect(url).toContain("scope=read%3Auser+user%3Aemail+read%3Aorg");
  });

  it("exchanges a code and merges identity claims from /user, /user/emails, and /user/orgs", async () => {
    const { provider, calls } = buildProvider((call) => {
      if (call.url.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "ghs_token", token_type: "bearer" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 42, login: "OctoCat", name: "Octo Cat", email: null }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.endsWith("/user/emails")) {
        return new Response(
          JSON.stringify([
            { email: "secondary@example.com", primary: false, verified: true },
            { email: "octo@example.com", primary: true, verified: true },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (call.url.endsWith("/user/orgs")) {
        return new Response(JSON.stringify([{ id: 7, login: "Cat-Cave", description: "the cat cave" }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const claims = await provider.exchangeCode("abc", "https://app.example.com/auth/callback");
    expect(claims).toMatchObject({
      providerSubject: "42",
      login: "OctoCat",
      email: "octo@example.com",
      displayName: "Octo Cat",
    });
    expect(claims.orgs).toEqual([
      { externalId: "7", login: "cat-cave", displayName: "the cat cave", kind: "github_org" },
    ]);
    expect(calls.some((c) => c.url.includes("login/oauth/access_token"))).toBe(true);
  });

  it("never exposes the client secret to /user calls", async () => {
    const { provider, calls } = buildProvider((call) => {
      if (call.url.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "ghs_token" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 1, login: "x", name: "X", email: null }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.endsWith("/user/emails")) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });
    await provider.exchangeCode("abc", "https://app.example.com/cb");
    const apiCalls = calls.filter((c) => !c.url.includes("login/oauth/access_token"));
    for (const call of apiCalls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      const headerValues = Object.values(headers).join(" ");
      expect(headerValues).not.toContain("client_secret_value");
      expect(call.url).not.toContain("client_secret_value");
    }
  });

  it("raises IdentityProviderError when GitHub returns an error payload", async () => {
    const { provider } = buildProvider((call) => {
      if (call.url.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ error: "bad_verification_code", error_description: "code is invalid" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    });
    await expect(provider.exchangeCode("bad", "https://app.example.com/cb")).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
  });
});
