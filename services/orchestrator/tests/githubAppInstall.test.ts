import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { migrateOrgConfig } from "../src/engine/config/orgConfig.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createGithubAppInstallRoutes } from "../src/routes/auth/githubAppInstall.js";
import { RoutesPool } from "./helpers/routesPool.js";

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

async function buildHarness() {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme", login: "acme", config: {} });
  const secrets = new InMemorySecretStore();
  await storeGithubAppCredential(secrets, {
    ref: "credential/github_app/org/org_acme/default",
    appId: "123456",
    privateKeyPem: pem(),
  });
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        token: "ghs_app",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      {
        status: 201,
      },
    )) as unknown as typeof fetch;
  const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async resolveActorContext() {
          return alice;
        },
      } as never,
      localDevActor: alice,
    }),
  );
  app.route(
    "/auth/github-app",
    createGithubAppInstallRoutes({
      pool: pool.asPgPool(),
      secrets,
      appCredentialRef: "credential/github_app/org/org_acme/default",
      installUrl: "https://github.com/apps/tanren/installations/new",
      minter,
    }),
  );
  return { app, pool };
}

describe("github app install flow", () => {
  it("redirects to the install url and sets a state cookie carrying the org id", async () => {
    const { app } = await buildHarness();
    const response = await app.request("/auth/github-app/install?orgId=org_acme", {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("installations/new");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("tanren_github_app_state=");
    expect(decodeURIComponent(cookie)).toContain("org_acme");
  });

  it("persists the installation to org config on a valid callback", async () => {
    const { app, pool } = await buildHarness();
    const start = await app.request("/auth/github-app/install?orgId=org_acme", {
      redirect: "manual",
    });
    const setCookie = start.headers.get("set-cookie") ?? "";
    const stateValue = decodeURIComponent(setCookie.split(";")[0]!.split("=")[1]!);

    const callback = await app.request(
      `/auth/github-app/callback?installation_id=42&state=${encodeURIComponent(stateValue)}`,
      { headers: { Cookie: `tanren_github_app_state=${encodeURIComponent(stateValue)}` } },
    );
    expect(callback.status).toBe(200);
    const body = (await callback.json()) as {
      ok: boolean;
      installation: { installationId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.installation.installationId).toBe("42");

    const config = migrateOrgConfig(pool.orgs.get("org_acme")!.config);
    expect(config.github_app?.installationId).toBe("42");
    expect(config.github_app?.appId).toBe("123456");
  });

  it("rejects a callback with a mismatched state", async () => {
    const { app } = await buildHarness();
    const callback = await app.request("/auth/github-app/callback?installation_id=42&state=abc.org_acme", {
      headers: { Cookie: "tanren_github_app_state=different" },
    });
    expect(callback.status).toBe(400);
  });
});
