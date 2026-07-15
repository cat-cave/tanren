// route contract tests: the capability-driven onboarding HTTP surface.
// Validates the structured not-linked response (200 link-first, not a crash), the
// cross-org guard, and the unresolvable-capability 400. The full provision/bind →
// persist → event flow is covered hermetically in integrationProvisioningEngine.test.ts
// (this layer would otherwise need a live provider). No real DB / provider here.

import { Hono } from "hono";
import type pg from "pg";
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

type Query = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

function poolFor(query: Query): pg.Pool {
  const client = { query, release() {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

// A pool that returns no connection/grant rows and absorbs transaction control.
const emptyQuery: Query = async () => ({ rows: [], rowCount: 0 });
function emptyPool(): pg.Pool {
  return poolFor(emptyQuery);
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

// A stateful in-memory pool modeling the authoritative connection + grant join so
// a LINK is visible to discover and list through the same repository path.
function statefulPool(): pg.Pool {
  const rows: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (text.startsWith("WITH connection AS ( INSERT INTO org_integration_connections")) {
      const [
        orgId,
        connectionId,
        providerKind,
        upstreamAccountId,
        authKind,
        credentialRef,
        ownerId,
        metadata,
        grantId,
        capabilities,
        operations,
        providerScopes,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string[],
        string[],
        string[],
      ];
      const row = {
        connection_id: connectionId,
        grant_id: grantId,
        org_id: orgId,
        provider_kind: providerKind,
        upstream_account_id: upstreamAccountId,
        auth_kind: authKind,
        credential_ref: credentialRef,
        auth_generation: 1,
        owner_id: ownerId,
        health: "unknown",
        connection_status: "active",
        metadata: JSON.parse(metadata ?? "{}"),
        plane: "control",
        environment: "control",
        capabilities,
        operations,
        provider_scopes: providerScopes,
        grant_generation: 1,
        grant_status: "active",
      };
      const existing = rows.findIndex(
        (r) =>
          r["org_id"] === orgId &&
          r["provider_kind"] === providerKind &&
          r["upstream_account_id"] === upstreamAccountId,
      );
      if (existing === -1) rows.push(row);
      else rows[existing] = row;
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM org_integration_connections c JOIN org_integration_grants g/u.test(text)) {
      const [orgId, providerKind] = params as string[];
      const found = rows.filter(
        (r) => r["org_id"] === orgId && (providerKind === undefined || r["provider_kind"] === providerKind),
      );
      return { rows: found, rowCount: found.length };
    }
    if (text.startsWith("SELECT p.project_id,")) {
      const [orgId, projectId] = params as string[];
      if (orgId !== "org_acme" || projectId !== "proj_1") return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            project_id: projectId,
            requirement_total: "2",
            requirement_needs_attention: "1",
            capability_total: "3",
            capability_awaiting_grant: "1",
            capability_ready: "1",
            capability_needs_attention: "1",
            binding_total: "1",
            binding_ready: "1",
            binding_drifted: "0",
            binding_needs_attention: "0",
            delivery_total: "1",
            delivery_completed: "1",
            delivery_degraded: "0",
            delivery_needs_attention: "0",
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  return poolFor(query);
}

function linkHarness(who: ActorContext, pool: pg.Pool, secrets: InMemorySecretStore) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return who;
        },
      } as never,
      localDevActor: who,
    }),
  );
  app.route("/orgs", createIntegrationRoutes({ pool, secrets }));
  return app;
}

const adminActor: ActorContext = { ...actor, scopes: ["org:admin"] };

describe("integration LINK route (POST /:orgId/integrations/:providerKind)", () => {
  it("stores the token ref + upserts the grant; discover then no longer returns not_linked", async () => {
    const pool = statefulPool();
    const secrets = new InMemorySecretStore();
    const app = linkHarness(adminActor, pool, secrets);

    const link = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "vercel_team_token",
        upstreamAccountId: "team_abc",
        authKind: "api_key",
        metadata: { teamId: "team_abc" },
      }),
    });
    expect(link.status).toBe(201);
    const linkBody = (await link.json()) as {
      status: string;
      connectionId: string;
      grantId: string;
      capabilities: string[];
    };
    expect(linkBody.status).toBe("linked");
    expect(linkBody.capabilities).toEqual(["deploy"]);
    // The token is stored by value in the secret store; the body carries neither
    // the value nor the internal credential ref.
    expect(JSON.stringify(linkBody)).not.toContain("vercel_team_token");
    expect(JSON.stringify(linkBody)).not.toContain("credentialRef");
    const stored = await secrets.get("secret://org/org_acme/integration/deploy.vercel/token");
    expect(stored?.value).toBe("vercel_team_token");

    // discover for the same provider now resolves the grant (no longer not_linked);
    // it reaches the provisioner (a live Vercel list would 5xx in this hermetic test
    // — what matters is it is NOT the not_linked branch).
    const disc = await app.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
      { method: "GET" },
    );
    const discBody = (await disc.json()) as { status?: string };
    expect(discBody.status).not.toBe("not_linked");
  });

  it("rejects a non-admin with 403", async () => {
    const app = linkHarness(actor, statefulPool(), new InMemorySecretStore());
    const res = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("org_admin_required");
  });

  it("rejects an unknown provider kind with 400", async () => {
    const app = linkHarness(adminActor, statefulPool(), new InMemorySecretStore());
    const res = await app.request("/orgs/org_acme/integrations/madeup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_provider_kind");
  });
});

describe("integration LIST route (GET /:orgId/integrations)", () => {
  it("returns an empty integrations array when nothing is linked", async () => {
    const res = await harness().request("/orgs/org_acme/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrations: unknown[] };
    expect(body.integrations).toEqual([]);
  });

  it("lists linked grants with credential REF + metadata KEYS only (no secret values)", async () => {
    const pool = statefulPool();
    const secrets = new InMemorySecretStore();
    const app = linkHarness(adminActor, pool, secrets);

    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "sentry_super_secret",
        upstreamAccountId: "sentry_acme",
        authKind: "api_key",
        metadata: { orgSlug: "unique-sentry-org-slug-xyz" },
      }),
    });
    expect(link.status).toBe(201);

    // A member (not just admin) can LIST.
    const memberApp = linkHarness(actor, pool, secrets);
    const res = await memberApp.request("/orgs/org_acme/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: Array<{
        providerKind: string;
        metadataKeys: string[];
        capabilities: string[];
        connectionStatus: string;
        grantStatus: string;
      }>;
    };
    expect(body.integrations).toHaveLength(1);
    const row = body.integrations[0]!;
    expect(row.providerKind).toBe("sentry");
    expect(row.capabilities).toEqual(["errors"]);
    expect(row.connectionStatus).toBe("active");
    expect(row.grantStatus).toBe("active");
    expect(row.metadataKeys).toEqual(["orgSlug"]);
    // Never leak the token value or metadata VALUES.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("sentry_super_secret");
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("unique-sentry-org-slug-xyz");
    expect(serialized).not.toMatch(/"metadata"\s*:/u);
  });

  it("makes lifecycle state callable for a selected project", async () => {
    const app = linkHarness(actor, statefulPool(), new InMemorySecretStore());
    const res = await app.request("/orgs/org_acme/integrations?projectId=proj_1", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lifecycle: unknown };
    expect(body.lifecycle).toEqual({
      projectId: "proj_1",
      requirements: { total: 2, needsAttention: 1 },
      capabilityNodes: { total: 3, awaitingGrant: 1, ready: 1, needsAttention: 1 },
      bindings: { total: 1, ready: 1, drifted: 0, needsAttention: 0 },
      deliveries: { total: 1, completed: 1, degraded: 0, needsAttention: 0 },
    });
  });

  it("guards cross-org list access with 403", async () => {
    const res = await harness().request("/orgs/org_intruder/integrations", { method: "GET" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("org_access_denied");
  });
});
