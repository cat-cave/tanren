import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  loadGithubAppCredential,
  storeGithubAppCredential,
  validateGithubAppCredentialRef,
} from "../src/engine/credentials/githubApp.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createCredentialRoutes, InMemoryCredentialRegistry } from "../src/routes/credentials/index.js";
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

describe("github app credential storage", () => {
  it("stores and reloads the app id + private key", async () => {
    const secrets = new InMemorySecretStore();
    const privateKeyPem = pem();
    const result = await storeGithubAppCredential(secrets, {
      ref: "credential/github_app/org/org_acme/default",
      appId: "123456",
      privateKeyPem,
    });
    expect(result.redacted).toBe(true);
    expect(result.appId).toBe("123456");
    const loaded = await loadGithubAppCredential(secrets, result.ref);
    expect(loaded.appId).toBe("123456");
    expect(loaded.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("rejects refs outside the credential/github_app/ namespace", () => {
    expect(() => validateGithubAppCredentialRef("credential/github/x")).toThrow(/credential\/github_app\//);
  });

  it("rejects non-numeric app ids and non-PEM keys", async () => {
    const secrets = new InMemorySecretStore();
    await expect(
      storeGithubAppCredential(secrets, {
        ref: "credential/github_app/x",
        appId: "abc",
        privateKeyPem: pem(),
      }),
    ).rejects.toThrow(/numeric/);
    await expect(
      storeGithubAppCredential(secrets, {
        ref: "credential/github_app/x",
        appId: "1",
        privateKeyPem: "not-a-key",
      }),
    ).rejects.toThrow(/PEM/);
  });
});

function buildCredHarness() {
  const pool = new RoutesPool();
  const secrets = new InMemorySecretStore();
  const registry = new InMemoryCredentialRegistry();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {
          return undefined;
        },
        async loadSession() {
          return undefined;
        },
        async resolveActorContext() {
          return alice;
        },
      } as never,
      localDevActor: alice,
    }),
  );
  app.route("/", createCredentialRoutes({ pool: pool.asPgPool(), secrets, registry }));
  return { app, registry };
}

describe("credential route github_app kind", () => {
  it("imports an app credential and records it without leaking the key", async () => {
    const { app, registry } = buildCredHarness();
    const response = await app.request("/orgs/org_acme/credentials?kind=github_app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "credential/github_app/org/org_acme/default",
        appId: "987654",
        privateKeyPem: pem(),
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.redacted).toBe(true);
    expect("privateKeyPem" in body).toBe(false);
    const record = await registry.get("credential/github_app/org/org_acme/default");
    expect(record?.kind).toBe("github_app");
  });

  it("returns 400 on an invalid app credential", async () => {
    const { app } = buildCredHarness();
    const response = await app.request("/orgs/org_acme/credentials?kind=github_app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "credential/github_app/org/org_acme/default",
        appId: "x",
        privateKeyPem: "bad",
      }),
    });
    expect(response.status).toBe(400);
  });
});
