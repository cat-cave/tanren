// Wave-2 operator API: route tests for the "Connect AI provider" + billing-mode
// surface. Drives the REAL handlers against the in-memory RoutesPool + an
// in-memory SecretStore/registry:
//   - connect (per-token providers + the Codex bundle) → GET reflects it, with a
//     CORRECT `classifiedAs` (so the operator knows the budget gate meters it);
//   - connecting with makeDefault wires the org's default LLM credential +
//     providerMode → byok (the same config path the rest of config uses);
//   - the billing toggle round-trips (managed ⇄ byok);
//   - the secret VALUE never appears in any response, and is stored under a
//     cost-classifiable ref (NOT credential/opaque/).

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { classifyAuthRef } from "../src/engine/costs/sources.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createAiProviderRoutes } from "../src/routes/aiProvider/index.js";
import { InMemoryCredentialRegistry } from "./helpers/inMemoryCredentialRegistry.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const member: ActorContext = { ...admin, scopes: ["org:member"] };

function buildHarness(actor: ActorContext) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", "user_alice", "admin");
  const secrets = new InMemorySecretStore();
  const registry = new InMemoryCredentialRegistry();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createAiProviderRoutes({ pool: pool.asPgPool(), secrets, registry }));
  return { app, pool, secrets, registry };
}

async function connect(app: Hono<ActorContextEnv>, body: Record<string, unknown>) {
  const res = await app.request("/orgs/org_acme/ai-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("ai-provider routes", () => {
  it("connects an OpenRouter key under a cost-classified ref and GET reflects it", async () => {
    const { app, secrets } = buildHarness(admin);
    const created = await connect(app, { provider: "openrouter", apiKey: "sk-or-secret" });

    expect(created.status).toBe(201);
    expect(created.body.provider).toBe("openrouter");
    expect(created.body.classifiedAs).toBe("per_token/openrouter");
    expect(created.body.isDefault).toBe(true);
    const ref = created.body.ref as string;
    expect(ref.startsWith("credential/openrouter/org/org_acme/")).toBe(true);
    // The ref prefix guarantees cost classification — the whole point.
    expect(classifyAuthRef(ref).billingMode).toBe("per_token");
    // The secret VALUE landed in the store under the classifiable ref, NOT opaque.
    expect((await secrets.get(ref))?.value).toBe("sk-or-secret");
    expect(await secrets.get(ref.replace("openrouter", "opaque"))).toBeUndefined();

    const listed = await app.request("/orgs/org_acme/ai-provider");
    const list = (await listed.json()) as {
      providerMode: string;
      providers: Array<{ provider: string; ref: string; classifiedAs: string; isDefault: boolean }>;
    };
    expect(list.providerMode).toBe("byok");
    expect(list.providers).toHaveLength(1);
    expect(list.providers[0]).toMatchObject({
      provider: "openrouter",
      ref,
      classifiedAs: "per_token/openrouter",
      isDefault: true,
    });
  });

  it("classifies anthropic + openai keys to the right metered provider", async () => {
    for (const [provider, expected] of [
      ["anthropic", "per_token/anthropic"],
      ["openai", "per_token/openai"],
    ] as const) {
      const { app } = buildHarness(admin);
      const created = await connect(app, { provider, apiKey: "k" });
      expect(created.status).toBe(201);
      expect(created.body.classifiedAs).toBe(expected);
      expect(classifyAuthRef(created.body.ref as string).billingMode).toBe("per_token");
    }
  });

  it("connects the Codex ChatGPT bundle as a subscription credential", async () => {
    const { app } = buildHarness(admin);
    const created = await connect(app, {
      provider: "codex",
      authJson: JSON.stringify({ OPENAI_API_KEY: "sk-codex" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.classifiedAs).toBe("subscription/openai");
    expect((created.body.ref as string).startsWith("credential/codex/org/org_acme/")).toBe(true);
  });

  it("wires the connected ref as the org default LLM credential + providerMode byok", async () => {
    const { app, pool } = buildHarness(admin);
    const created = await connect(app, { provider: "openrouter", apiKey: "sk-or-secret" });
    const config = pool.orgs.get("org_acme")?.config as {
      providerMode: string;
      defaultCredentials?: { codex_chatgpt_auth?: string };
    };
    expect(config.providerMode).toBe("byok");
    expect(config.defaultCredentials?.codex_chatgpt_auth).toBe(created.body.ref);
  });

  it("makeDefault:false connects without changing routing/default", async () => {
    const { app, pool } = buildHarness(admin);
    const created = await connect(app, { provider: "openrouter", apiKey: "k", makeDefault: false });
    expect(created.body.isDefault).toBe(false);
    const config = pool.orgs.get("org_acme")?.config as { defaultCredentials?: { codex_chatgpt_auth?: string } };
    expect(config.defaultCredentials?.codex_chatgpt_auth).toBeUndefined();
    // The GET still shows it, just not as default.
    const listed = await app.request("/orgs/org_acme/ai-provider");
    const list = (await listed.json()) as { providers: Array<{ isDefault: boolean }> };
    expect(list.providers[0]?.isDefault).toBe(false);
  });

  it("never returns or exposes the secret value in any response", async () => {
    const { app } = buildHarness(admin);
    const created = await connect(app, { provider: "openrouter", apiKey: "TOP-SECRET-KEY" });
    expect(JSON.stringify(created.body)).not.toContain("TOP-SECRET-KEY");
    expect(created.body).not.toHaveProperty("apiKey");
    expect(created.body).not.toHaveProperty("value");

    const listed = await app.request("/orgs/org_acme/ai-provider");
    expect(await listed.text()).not.toContain("TOP-SECRET-KEY");
  });

  it("toggles billing mode managed ⇄ byok and round-trips", async () => {
    const { app, pool } = buildHarness(admin);
    const toManaged = await app.request("/orgs/org_acme/billing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "managed" }),
    });
    expect(toManaged.status).toBe(200);
    expect((await toManaged.json()) as { mode: string }).toEqual({ mode: "managed" });
    const managedConfig = pool.orgs.get("org_acme")?.config as { providerMode: string } | undefined;
    expect(managedConfig?.providerMode).toBe("managed");

    const back = await app.request("/orgs/org_acme/billing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "byok" }),
    });
    expect((await back.json()) as { mode: string }).toEqual({ mode: "byok" });
  });

  it("rejects an unknown provider and a bad billing mode", async () => {
    const { app } = buildHarness(admin);
    const badProvider = await connect(app, { provider: "mystery", apiKey: "k" });
    expect(badProvider.status).toBe(400);
    const badMode = await app.request("/orgs/org_acme/billing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "free" }),
    });
    expect(badMode.status).toBe(400);
  });

  it("requires org admin to connect or toggle, and membership to list", async () => {
    const memberHarness = buildHarness(member);
    const connectAsMember = await connect(memberHarness.app, { provider: "openrouter", apiKey: "k" });
    expect(connectAsMember.status).toBe(403);
    const toggleAsMember = await memberHarness.app.request("/orgs/org_acme/billing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "managed" }),
    });
    expect(toggleAsMember.status).toBe(403);
    // A member CAN list.
    const listed = await memberHarness.app.request("/orgs/org_acme/ai-provider");
    expect(listed.status).toBe(200);

    // A non-member is denied entirely.
    const stranger = buildHarness({ ...admin, orgId: "org_other" });
    const denied = await stranger.app.request("/orgs/org_acme/ai-provider");
    expect(denied.status).toBe(403);
  });
});
