import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
  resolveGithubToken,
} from "../src/engine/credentials/githubTokenResolver.js";
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
    const resolved = await resolveGithubToken({
      secrets,
      staticRef: "credential/github/org/o1/default",
      staticRefOrgId: "o1",
    });
    expect(resolved.source).toBe("static");
    expect(resolved.token).toBe("ghp_static");
    expect(await resolved.refresh()).toBe("ghp_static");
  });

  it("rejects a cross-org static ref immediately before SecretStore access", async () => {
    let secretReads = 0;
    const secrets = {
      get: async () => {
        secretReads += 1;
      },
    } as never;
    await expect(
      resolveGithubToken({
        secrets,
        staticRef: "credential/github/org/org_b/default",
        staticRefOrgId: "org_a",
      }),
    ).rejects.toThrow("credential ref does not belong to the authenticated owner");
    expect(secretReads).toBe(0);
  });

  it("throws a descriptive error when the configured static ref is missing", async () => {
    const secrets = new InMemorySecretStore();
    await expect(resolveGithubToken({ secrets, staticRef: "credential/github/org/o1/absent" })).rejects.toThrow(
      "missing GitHub credential ref: credential/github/org/o1/absent",
    );
    await expect(resolveGithubToken({ secrets, staticRef: "credential/github/org/o1/absent" })).rejects.toMatchObject({
      name: "MissingGithubCredentialRefError",
      retriable: false,
    });
    expect(new MissingGithubCredentialRefError("credential/github/org/o1/absent").retriable).toBe(false);
  });

  it("does NOT consult TANREN_GITHUB_APP_TOKEN_REF — deploy env is not a runtime credential source", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/github/env-ref", value: "ghp_from_env" });
    const prior = process.env["TANREN_GITHUB_APP_TOKEN_REF"];
    process.env["TANREN_GITHUB_APP_TOKEN_REF"] = "credential/github/env-ref";
    try {
      // No staticRef + no installation ⇒ hard config error, even though the env
      // ref points at a real secret. The github credential is userland config only.
      await expect(resolveGithubToken({ secrets })).rejects.toBeInstanceOf(NoGithubCredentialConfiguredError);
    } finally {
      if (prior === undefined) {
        delete process.env["TANREN_GITHUB_APP_TOKEN_REF"];
      } else {
        process.env["TANREN_GITHUB_APP_TOKEN_REF"] = prior;
      }
    }
  });

  it("throws a clear config error when no installation, staticRef, or env ref is configured", async () => {
    const secrets = new InMemorySecretStore();
    const prior = process.env["TANREN_GITHUB_APP_TOKEN_REF"];
    delete process.env["TANREN_GITHUB_APP_TOKEN_REF"];
    try {
      // No hardcoded default ref: an unconfigured run is a hard config error,
      // NOT a silent fall-through to `credential/github/default`.
      await expect(resolveGithubToken({ secrets })).rejects.toThrow(/No GitHub credential configured for this run/u);
      await expect(resolveGithubToken({ secrets })).rejects.toMatchObject({
        name: "NoGithubCredentialConfiguredError",
        retriable: false,
      });
      expect(new NoGithubCredentialConfiguredError().retriable).toBe(false);
    } finally {
      if (prior !== undefined) {
        process.env["TANREN_GITHUB_APP_TOKEN_REF"] = prior;
      }
    }
  });

  it("re-reads the static secret on refresh, observing a rotated value", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/github/org/o1/default", value: "ghp_v1" });
    const resolved = await resolveGithubToken({
      secrets,
      staticRef: "credential/github/org/o1/default",
      staticRefOrgId: "o1",
    });
    expect(resolved.token).toBe("ghp_v1");
    await secrets.put({ ref: "credential/github/org/o1/default", value: "ghp_v2" });
    expect(await resolved.refresh()).toBe("ghp_v2");
  });

  it("prefers an App installation token when an installation is configured", async () => {
    const secrets = new InMemorySecretStore();
    await storeGithubAppCredential(secrets, {
      ref: "credential/github_app/org/o1/default",
      appId: "1",
      privateKeyPem: pem(),
    });
    // A static fallback secret IS present, so this test also proves the App
    // path is PREFERRED over the static ref (the static value must never win).
    await secrets.put({ ref: "credential/github/org/o1/default", value: "ghp_static_should_not_win" });
    let minted = 0;
    const fetchImpl = (async () => {
      minted += 1;
      return new Response(
        JSON.stringify({
          token: `ghs_app_${minted}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
    const resolved = await resolveGithubToken({
      secrets,
      installation: {
        installationId: "42",
        appId: "1",
        credentialRef: "credential/github_app/org/o1/default",
        installedAt: "now",
      },
      staticRef: "credential/github/org/o1/default",
      minter,
    });
    expect(resolved.source).toBe("github_app");
    expect(resolved.token).toBe("ghs_app_1");
    // refresh() force-mints a NEW installation token rather than reusing cache.
    expect(await resolved.refresh()).toBe("ghs_app_2");
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
    const client = new FetchGitHubHttpClient({ apiBaseUrl: "https://api.github.com", fetchImpl });
    const response = await client.request({
      method: "GET",
      path: "/repos/x/y",
      token: "stale",
      refreshToken: async () => "fresh",
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
    const client = new FetchGitHubHttpClient({ apiBaseUrl: "https://api.github.com", fetchImpl });
    const response = await client.request({ method: "GET", path: "/repos/x/y", token: "stale" });
    expect(response.status).toBe(401);
    expect(call).toBe(1);
  });
});
