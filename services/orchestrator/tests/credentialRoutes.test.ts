import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createCredentialRoutes, InMemoryCredentialRegistry } from "../src/routes/credentials/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildHarness(actor: ActorContext) {
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
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/", createCredentialRoutes({ pool: pool.asPgPool(), secrets, registry }));
  return { app, pool, secrets, registry };
}

describe("credential routes", () => {
  it("creates an opaque credential for an org and lists it", async () => {
    const { app } = buildHarness(alice);
    const created = await app.request("/orgs/org_acme/credentials?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "credential/opaque/org/org_acme/api-key",
        value: "secret-value",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { ref: string; redacted: boolean };
    expect(createdBody.redacted).toBe(true);
    expect("value" in createdBody).toBe(false);

    const listed = await app.request("/orgs/org_acme/credentials");
    const list = (await listed.json()) as { credentials: Array<{ ref: string }> };
    expect(list.credentials.map((row) => row.ref)).toContain("credential/opaque/org/org_acme/api-key");
  });

  it("never returns secret values in the response payload", async () => {
    const { app } = buildHarness(alice);
    await app.request("/orgs/org_acme/credentials?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opaque/org/org_acme/k1", value: "shh" }),
    });
    const got = await app.request("/orgs/org_acme/credentials/credential%2Fopaque%2Forg%2Forg_acme%2Fk1");
    const body = (await got.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("value");
    expect(body).toHaveProperty("ref");
  });

  it("rejects access to a cross-org credential listing", async () => {
    const { app } = buildHarness(alice);
    const response = await app.request("/orgs/org_other/credentials");
    expect(response.status).toBe(403);
  });

  it("deletes a credential from both Vault and the registry", async () => {
    const { app, secrets, registry } = buildHarness(alice);
    await app.request("/orgs/org_acme/credentials?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opaque/org/org_acme/k2", value: "v" }),
    });
    const response = await app.request("/orgs/org_acme/credentials/credential%2Fopaque%2Forg%2Forg_acme%2Fk2", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await secrets.get("credential/opaque/org/org_acme/k2")).toBeUndefined();
    expect(await registry.get("credential/opaque/org/org_acme/k2")).toBeUndefined();
  });

  it("derives the Vault ref from the actor's org when the caller supplies a bare name", async () => {
    const { app, secrets, registry } = buildHarness(alice);
    const created = await app.request("/orgs/org_acme/credentials?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "api-key", value: "v" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { ref: string };
    expect(body.ref).toBe("credential/opaque/org/org_acme/api-key");
    // The secret + registry record both land under the derived tenant ref.
    expect(await secrets.get("credential/opaque/org/org_acme/api-key")).toEqual({
      ref: "credential/opaque/org/org_acme/api-key",
      value: "v",
    });
    expect(await registry.get("credential/opaque/org/org_acme/api-key")).toMatchObject({
      scope: "org",
      ownerId: "org_acme",
    });
  });

  it("rejects an org import whose ref names a different tenant (Tier-A #3)", async () => {
    const { app, secrets } = buildHarness(alice);
    const response = await app.request("/orgs/org_acme/credentials?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opaque/org/org_evil/stolen", value: "v" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_credential");
    expect(body.message).toContain("does not belong to the authenticated owner");
    // Nothing was written under the attacker-named ref.
    expect(await secrets.get("credential/opaque/org/org_evil/stolen")).toBeUndefined();
  });

  it("derives a me-scoped ref under the actor's user id and rejects another user's ref", async () => {
    const { app } = buildHarness(alice);
    const ok = await app.request("/credentials/me?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "dev", value: "v" }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { ref: string }).ref).toBe("credential/opaque/me/user_alice/dev");

    const cross = await app.request("/credentials/me?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opaque/me/user_mallory/dev", value: "v" }),
    });
    expect(cross.status).toBe(400);
  });

  it("derives github_token and github_app refs into the actor's namespace", async () => {
    const { app } = buildHarness(alice);
    const token = await app.request("/orgs/org_acme/credentials?kind=github_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "ci", token: "ghp_abc" }),
    });
    expect(token.status).toBe(201);
    expect(((await token.json()) as { ref: string }).ref).toBe("credential/github/org/org_acme/ci");

    const crossToken = await app.request("/orgs/org_acme/credentials?kind=github_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/github/org/org_evil/ci", token: "ghp_abc" }),
    });
    expect(crossToken.status).toBe(400);
    expect(((await crossToken.json()) as { error: string }).error).toBe("invalid_github_credential");
  });

  it("lists the actor's personal credentials separately from org credentials", async () => {
    const { app } = buildHarness(alice);
    await app.request("/credentials/me?kind=opaque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opaque/me/user_alice/dev", value: "v" }),
    });
    const response = await app.request("/credentials/me");
    const body = (await response.json()) as {
      credentials: Array<{ ownerId: string; scope: string }>;
    };
    expect(body.credentials.length).toBe(1);
    expect(body.credentials[0]?.scope).toBe("me");
    expect(body.credentials[0]?.ownerId).toBe("user_alice");
  });
});
