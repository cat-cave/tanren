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
