import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import { resolveGithubToken } from "../src/engine/credentials/githubTokenResolver.js";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("resolveGithubToken", () => {
  it("reads a static secret when no installation is configured", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/github/org/o1/default", value: "ghp_static" });
    const resolved = await resolveGithubToken({ secrets, staticRef: "credential/github/org/o1/default" });
    expect(resolved.source).toBe("static");
    expect(resolved.token).toBe("ghp_static");
    expect(await resolved.refresh()).toBe("ghp_static");
  });

  it("prefers an App installation token when an installation is configured", async () => {
    const secrets = new InMemorySecretStore();
    await storeGithubAppCredential(secrets, { ref: "credential/github_app/org/o1/default", appId: "1", privateKeyPem: pem() });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ token: "ghs_app", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), {
        status: 201
      })) as unknown as typeof fetch;
    const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
    const resolved = await resolveGithubToken({
      secrets,
      installation: { installationId: "42", appId: "1", credentialRef: "credential/github_app/org/o1/default", installedAt: "now" },
      staticRef: "credential/github/org/o1/default",
      minter
    });
    expect(resolved.source).toBe("github_app");
    expect(resolved.token).toBe("ghs_app");
  });
});

describe("FetchGitHubHttpClient 401 refresh", () => {
  it("retries once with a freshly minted token on a 401", async () => {
    let call = 0;
    const tokensSeen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      call += 1;
      tokensSeen.push(String((init.headers as Record<string, string>).Authorization));
      return new Response("", { status: call === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient("https://api.github.com", fetchImpl);
    const response = await client.request({
      method: "GET",
      path: "/repos/x/y",
      token: "stale",
      refreshToken: async () => "fresh"
    });
    expect(response.status).toBe(200);
    expect(call).toBe(2);
    expect(tokensSeen[0]).toContain("stale");
    expect(tokensSeen[1]).toContain("fresh");
  });

  it("does not retry a 401 when no refreshToken is supplied", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response("", { status: 401 });
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient("https://api.github.com", fetchImpl);
    const response = await client.request({ method: "GET", path: "/repos/x/y", token: "stale" });
    expect(response.status).toBe(401);
    expect(call).toBe(1);
  });
});
