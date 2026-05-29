import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import { GithubAppTokenMinter, signAppJwt } from "../src/engine/providers/githubAppTokenMinter.js";

function newKeyPair(): { privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

async function seededSecrets(privateKeyPem: string): Promise<InMemorySecretStore> {
  const secrets = new InMemorySecretStore();
  await storeGithubAppCredential(secrets, {
    ref: "credential/github_app/org/o1/default",
    appId: "123456",
    privateKeyPem,
  });
  return secrets;
}

describe("signAppJwt", () => {
  it("produces a three-segment RS256 JWT with the app id as issuer", () => {
    const { privateKeyPem } = newKeyPair();
    const jwt = signAppJwt("123456", privateKeyPem, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as {
      alg: string;
    };
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBeLessThan(payload.exp);
  });
});

describe("GithubAppTokenMinter", () => {
  it("exchanges an app JWT for an installation token and caches it", async () => {
    const { privateKeyPem } = newKeyPair();
    const secrets = await seededSecrets(privateKeyPem);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          token: "ghs_installation",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;

    const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
    const request = {
      installationId: "999",
      credentialRef: "credential/github_app/org/o1/default",
    };

    const first = await minter.getInstallationToken(request);
    const second = await minter.getInstallationToken(request);

    expect(first).toBe("ghs_installation");
    expect(second).toBe("ghs_installation");
    expect(calls).toBe(1); // second served from cache
  });

  it("re-mints on refresh and when the cached token is within the expiry window", async () => {
    const { privateKeyPem } = newKeyPair();
    const secrets = await seededSecrets(privateKeyPem);
    let now = 1_700_000_000_000;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          token: `ghs_${calls}`,
          expires_at: new Date(now + 3_600_000).toISOString(),
        }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;

    const minter = new GithubAppTokenMinter({ secrets, fetchImpl, now: () => now });
    const request = {
      installationId: "999",
      credentialRef: "credential/github_app/org/o1/default",
    };

    expect(await minter.getInstallationToken(request)).toBe("ghs_1");
    // advance close to expiry → cache miss, re-mint
    now += 3_600_000;
    expect(await minter.getInstallationToken(request)).toBe("ghs_2");
    // forced refresh
    expect(await minter.refreshInstallationToken(request)).toBe("ghs_3");
    expect(calls).toBe(3);
  });

  it("throws when the mint endpoint does not return 201", async () => {
    const { privateKeyPem } = newKeyPair();
    const secrets = await seededSecrets(privateKeyPem);
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
    await expect(
      minter.getInstallationToken({
        installationId: "999",
        credentialRef: "credential/github_app/org/o1/default",
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});
