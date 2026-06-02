// P-INT-2 route contract tests: the capability-driven onboarding HTTP surface.
// Validates the structured not-linked response (200 link-first, not a crash), the
// cross-org guard, and the unresolvable-capability 400. The full provision/bind →
// persist → event flow is covered hermetically in integrationProvisioningEngine.test.ts
// (this layer would otherwise need a live provider). No real DB / provider here.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationRoutes } from "../src/routes/integrations/index.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

// A pool that returns no org_integrations rows (nothing linked) and absorbs writes.
const emptyQuery = async (): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows: [], rowCount: 0 });
function emptyPool(): never {
  return { query: emptyQuery } as never;
}

function harness(who: ActorContext | undefined = actor) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return who as ActorContext;
        },
      } as never,
      localDevActor: who,
    }),
  );
  app.route("/orgs", createIntegrationRoutes({ pool: emptyPool(), secrets: new InMemorySecretStore() }));
  return app;
}

const base = "/orgs/org_acme/projects/proj_1/integrations/provision";

describe("integration provisioning routes (P-INT-2)", () => {
  it("returns a structured not-linked response (200) when the org has no grant", async () => {
    const res = await harness().request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "errors", mode: "greenfield", name: "acme-web" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; providerKind: string; linkAffordance: unknown };
    expect(body.status).toBe("not_linked");
    expect(body.providerKind).toBe("sentry");
    expect(body.linkAffordance).toEqual({
      kind: "org_integration_link",
      providerKind: "sentry",
      orgId: "org_acme",
    });
  });

  it("rejects an unresolvable capability with 400 (not a 500 crash)", async () => {
    const res = await harness().request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "deploy", mode: "greenfield" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unresolvable_capability");
  });

  it("guards cross-org access with 403", async () => {
    const res = await harness().request("/orgs/org_intruder/projects/p/integrations/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "errors", mode: "greenfield" }),
    });
    expect(res.status).toBe(403);
  });

  it("discover returns not-linked (200) when no grant exists", async () => {
    const res = await harness().request("/orgs/org_acme/projects/proj_1/integrations/discover?capability=notify", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; providerKind: string };
    expect(body.status).toBe("not_linked");
    expect(body.providerKind).toBe("slack");
  });
});
