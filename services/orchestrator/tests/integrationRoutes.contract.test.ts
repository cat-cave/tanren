import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type {
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../src/engine/contracts/integrationProvisioner.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import type { IntegrationQueryClient, IntegrationQueryResult } from "../src/engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationRoutes, type IntegrationRouteDatabase } from "../src/routes/integrations/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { IntegrationMemoryDb } from "./helpers/integrationMemoryDb.js";

const member: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: "proj_1",
  scopes: ["org:member", "project:member"],
  source: "session",
};
const admin: ActorContext = { ...member, projectId: null, scopes: ["org:admin"] };

class RouteClient implements IntegrationQueryClient {
  constructor(
    private readonly base: IntegrationQueryClient,
    private readonly orgId: string,
    private readonly projectMembers: ReadonlySet<string>,
  ) {}

  async query(rawSql: string, params: unknown[] = []): Promise<IntegrationQueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (sql === "SELECT project_id FROM projects WHERE org_id = $1 AND project_id = $2") {
      const [orgId, projectId] = params as [string, string];
      const found = orgId === this.orgId && projectId === "proj_1";
      return { rows: found ? [{ project_id: projectId }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql === "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2") {
      const [projectId, userId] = params as [string, string];
      const found = projectId === "proj_1" && this.projectMembers.has(userId);
      return { rows: found ? [{ role: "member" }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.startsWith("SELECT p.project_id, o.login AS org_slug")) {
      const [orgId, projectId] = params as [string, string];
      const found = orgId === this.orgId && projectId === "proj_1";
      return { rows: found ? [{ project_id: projectId, org_slug: "acme" }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.startsWith("SELECT p.project_id,")) {
      const [orgId, projectId] = params as [string, string];
      const found = orgId === this.orgId && projectId === "proj_1";
      return {
        rows: found
          ? [
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
            ]
          : [],
        rowCount: found ? 1 : 0,
      };
    }
    return this.base.query(rawSql, params);
  }
}

class RouteDatabase implements IntegrationRouteDatabase {
  readonly events = new FakeEventStore();
  readonly memory = new IntegrationMemoryDb();

  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T> {
    return work(new RouteClient(this.memory.clientForOrg(orgId), orgId, new Set(["user_alice"])));
  }
}

class RecordingProvisioner implements IntegrationProvisioner {
  calls = 0;
  grants: OrgGrant[] = [];
  capability(): string[] {
    return ["errors", "notify", "deploy"];
  }
  async discover(grant: OrgGrant): Promise<ExistingResource[]> {
    this.calls += 1;
    this.grants.push(grant);
    return [{ id: "r1", label: "resource", metadata: {} }];
  }
  async provision(grant: OrgGrant, _ctx: ProjectContext): Promise<ProvisionedArtifact> {
    this.calls += 1;
    this.grants.push(grant);
    return { projectConfig: { ok: true } };
  }
  async bind(grant: OrgGrant, _id: string, _ctx: ProjectContext): Promise<ProvisionedArtifact> {
    this.calls += 1;
    this.grants.push(grant);
    return { projectConfig: { ok: true } };
  }
}

function harness(input: {
  actor: ActorContext;
  database?: RouteDatabase;
  secrets?: InMemorySecretStore;
  provisioner?: RecordingProvisioner;
  fetchImpl?: typeof fetch;
}) {
  const database = input.database ?? new RouteDatabase();
  const secrets = input.secrets ?? new InMemorySecretStore();
  const provisioner = input.provisioner ?? new RecordingProvisioner();
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", input.actor);
    return next();
  });
  app.route(
    "/orgs",
    createIntegrationRoutes({
      database,
      secrets,
      integrationSecrets: new GenerationAddressedIntegrationSecretStore(secrets),
      buildProvisioner: () => provisioner,
      fetchImpl: input.fetchImpl,
    }),
  );
  return { app, database, secrets, provisioner };
}

function vercelFetchFor(teamId: string): typeof fetch {
  return vi.fn<typeof fetch>(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/v2/user")) {
      return Response.json({ user: { id: `user_for_${teamId}`, username: "u" } });
    }
    if (href.includes("/v2/teams")) {
      return Response.json({ teams: [{ id: teamId, name: teamId, slug: teamId }] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const provisionPath = "/orgs/org_acme/projects/proj_1/integrations/provision";

describe("integration routes auth + sanitization", () => {
  it("rejects unauthenticated and non-admin link before staging secrets", async () => {
    const secrets = new InMemorySecretStore();
    const unauth = new Hono<ActorContextEnv>();
    unauth.route("/orgs", createIntegrationRoutes({ database: new RouteDatabase(), secrets }));
    expect((await unauth.request("/orgs/org_acme/integrations")).status).toBe(401);

    const memberApp = harness({ actor: member, secrets }).app;
    const link = await memberApp.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t", idempotencyKey: "k1" }),
    });
    expect(link.status).toBe(403);
    expect(await secrets.list("secret://")).toEqual([]);
  });

  it("rejects invalid link bodies without provider I/O", async () => {
    const { app } = harness({ actor: admin });
    const response = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("verified principal link + multi-principal selection", () => {
  it("links via provider-verified principal and never echoes tokens", async () => {
    const database = new RouteDatabase();
    const secrets = new InMemorySecretStore();
    const { app } = harness({
      actor: admin,
      database,
      secrets,
      fetchImpl: vercelFetchFor("team_a"),
    });
    const response = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token_team_a", idempotencyKey: "link-a" }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "completed",
      providerPrincipalId: "team_a",
    });
    expect(JSON.stringify(body)).not.toContain("token_team_a");
    expect(database.memory.connections[0]?.provider_principal_id).toBe("team_a");
  });

  it("returns awaiting_principal_selection for multi-principal credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/v2/user")) return Response.json({ user: { id: "user_1", username: "u" } });
      if (href.includes("/v2/teams")) {
        return Response.json({
          teams: [
            { id: "team_a", name: "A", slug: "a" },
            { id: "team_b", name: "B", slug: "b" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const { app, database } = harness({ actor: admin, fetchImpl });
    const response = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "multi", idempotencyKey: "multi-1" }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ status: "awaiting_principal_selection" });
    expect(body.candidates).toHaveLength(2);
    expect(database.memory.connections).toHaveLength(0);
  });

  it("requires project selection before provider I/O and never returns credential refs", async () => {
    const database = new RouteDatabase();
    const secrets = new InMemorySecretStore();
    const provisioner = new RecordingProvisioner();
    const { app } = harness({
      actor: admin,
      database,
      secrets,
      provisioner,
      fetchImpl: vercelFetchFor("team_only"),
    });
    const linked = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t", idempotencyKey: "one" }),
    });
    expect(linked.status).toBe(202);
    const linkedBody = (await linked.json()) as {
      connectionId: string;
      grantId: string;
      authGeneration: number;
      grantGeneration: number;
    };

    const memberApp = harness({ actor: member, database, secrets, provisioner }).app;
    const ambiguous = await memberApp.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
    );
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ status: "selection_required" });
    expect(provisioner.calls).toBe(0);

    const selected = await memberApp.request("/orgs/org_acme/projects/proj_1/integrations/deploy.vercel/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: linkedBody.connectionId,
        grantId: linkedBody.grantId,
        authGeneration: linkedBody.authGeneration,
        grantGeneration: linkedBody.grantGeneration,
      }),
    });
    expect(selected.status).toBe(200);

    const discovered = await memberApp.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
    );
    expect(discovered.status).toBe(200);
    expect(provisioner.grants.at(-1)).toMatchObject({
      connectionId: linkedBody.connectionId,
      providerPrincipalId: "team_only",
    });
    expect(JSON.stringify(await discovered.json())).not.toContain("credentialRef");
  });

  it("returns structured not-linked without constructing a provider", async () => {
    const provisioner = new RecordingProvisioner();
    const { app } = harness({ actor: member, provisioner });
    const response = await app.request(provisionPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "errors", mode: "greenfield" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_linked", providerKind: "sentry" });
    expect(provisioner.calls).toBe(0);
  });

  it("lists verified principals and lifecycle without secret material", async () => {
    const database = new RouteDatabase();
    const { app } = harness({
      actor: admin,
      database,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        Response.json([{ id: "org_1", slug: "acme", name: "Acme" }]),
      ) as unknown as typeof fetch,
    });
    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret-value", idempotencyKey: "sentry-1" }),
    });
    expect(link.status).toBe(202);
    const linked = (await link.json()) as {
      connectionId: string;
      grantId: string;
      authGeneration: number;
      grantGeneration: number;
    };
    const memberApp = harness({ actor: member, database }).app;
    await memberApp.request("/orgs/org_acme/projects/proj_1/integrations/sentry/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: linked.connectionId,
        grantId: linked.grantId,
        authGeneration: linked.authGeneration,
        grantGeneration: linked.grantGeneration,
      }),
    });
    const response = await memberApp.request("/orgs/org_acme/integrations?projectId=proj_1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      integrations: [{ providerKind: "sentry", providerPrincipalId: "org_1", selectedForProject: true }],
      lifecycle: { projectId: "proj_1", requirements: { total: 2, needsAttention: 1 } },
    });
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("credentialRef");
  });
});
