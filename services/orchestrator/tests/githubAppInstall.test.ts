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

// A non-admin/non-member actor used to prove the H1 org-admin authorization
// gate: install/callback must 403 unless the actor is an admin of the TARGET org.
const mallory: ActorContext = {
  userId: "user_mallory",
  orgId: "org_other",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

async function buildHarness(actor: ActorContext = alice) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme", login: "acme", config: { version: 1 } });
  // H1: alice is an ADMIN of org_acme (the target org). The install/callback
  // org-admin check reads `org_members` directly, so the membership must exist
  // for the happy path. `mallory` gets NO membership in org_acme → 403.
  pool.seedMembership("org_acme", "user_alice", "admin");
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
          return actor;
        },
      } as never,
      localDevActor: actor,
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

  // H1 (cross-tenant security hole): the install/callback routes must re-authorize
  // the TARGET org against the actor (org-admin), not trust the request-supplied
  // org. A non-member actor is a LOUD 403 — never a silent write.
  it("H1: rejects /install for an actor who is not an admin of the target org (403)", async () => {
    const { app } = await buildHarness(mallory);
    const response = await app.request("/auth/github-app/install?orgId=org_acme", { redirect: "manual" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "org_access_denied" });
    // No state cookie is issued to an unauthorized actor.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("H1: rejects /callback for a non-member actor and does NOT write the org config (403)", async () => {
    // Mint a valid (nonce.org) state by issuing it as an ADMIN, then replay the
    // callback as the non-member `mallory`. The org-admin re-authorization on the
    // callback must still refuse — a valid state cookie is NOT authorization.
    const admin = await buildHarness(alice);
    const start = await admin.app.request("/auth/github-app/install?orgId=org_acme", { redirect: "manual" });
    const setCookie = start.headers.get("set-cookie") ?? "";
    const stateValue = decodeURIComponent(setCookie.split(";")[0]!.split("=")[1]!);

    const { app, pool } = await buildHarness(mallory);
    const callback = await app.request(
      `/auth/github-app/callback?installation_id=42&state=${encodeURIComponent(stateValue)}`,
      { headers: { Cookie: `tanren_github_app_state=${encodeURIComponent(stateValue)}` } },
    );
    expect(callback.status).toBe(403);
    expect(await callback.json()).toMatchObject({ error: "org_access_denied" });
    // The org's config was never touched (no github_app block written).
    const config = migrateOrgConfig(pool.orgs.get("org_acme")!.config);
    expect(config.github_app).toBeUndefined();
  });
});
