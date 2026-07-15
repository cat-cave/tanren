import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type {
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../src/engine/contracts/integrationProvisioner.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
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
  readonly projectMembers = new Set(["user_alice"]);

  constructor() {
    this.memory.seedProject("proj_1", "org_acme");
  }

  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T> {
    return work(new RouteClient(this.memory.clientForOrg(orgId), orgId, this.projectMembers));
  }
}

class RecordingProvisioner implements IntegrationProvisioner {
  readonly grants: OrgGrant[] = [];
  calls = 0;

  capability(): string[] {
    return ["errors", "deploy"];
  }

  async discover(grant: OrgGrant): Promise<ExistingResource[]> {
    this.calls += 1;
    this.grants.push(grant);
    return [{ id: "resource_1", label: "existing", metadata: {} }];
  }

  async provision(grant: OrgGrant, _project: ProjectContext): Promise<ProvisionedArtifact> {
    this.calls += 1;
    this.grants.push(grant);
    return {};
  }

  async bind(grant: OrgGrant, _resourceId: string, _project: ProjectContext): Promise<ProvisionedArtifact> {
    this.calls += 1;
    this.grants.push(grant);
    return {};
  }
}

function harness(input: {
  actor?: ActorContext;
  database?: RouteDatabase;
  secrets?: InMemorySecretStore;
  provisioner?: RecordingProvisioner;
}) {
  const database = input.database ?? new RouteDatabase();
  const secrets = input.secrets ?? new InMemorySecretStore();
  const app = new Hono<ActorContextEnv>();
  if (input.actor !== undefined) {
    app.use("*", async (c, next) => {
      c.set("actor", input.actor);
      await next();
    });
  }
  app.route(
    "/orgs",
    createIntegrationRoutes({
      database,
      secrets,
      ...(input.provisioner === undefined ? {} : { buildProvisioner: () => input.provisioner! }),
    }),
  );
  return { app, database, secrets };
}

const provisionPath = "/orgs/org_acme/projects/proj_1/integrations/provision";

describe("integration route authorization before effects", () => {
  it("returns 401 without an actor and never constructs a provider", async () => {
    const provisioner = new RecordingProvisioner();
    const { app } = harness({ provisioner });
    expect((await app.request(provisionPath, { method: "POST" })).status).toBe(401);
    expect(provisioner.calls).toBe(0);
  });

  it("rejects cross-org, non-member, missing-project, and malformed requests before provider I/O", async () => {
    const provisioner = new RecordingProvisioner();
    const deniedDb = new RouteDatabase();
    deniedDb.projectMembers.clear();
    const denied = harness({
      actor: { ...member, projectId: null, scopes: ["org:member"] },
      database: deniedDb,
      provisioner,
    });
    expect(
      (
        await denied.app.request(provisionPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capability: "errors", mode: "greenfield" }),
        })
      ).status,
    ).toBe(403);

    const normal = harness({ actor: member, provisioner });
    expect(
      (await normal.app.request("/orgs/org_intruder/projects/proj_1/integrations/discover?capability=errors")).status,
    ).toBe(403);
    expect(
      (await normal.app.request("/orgs/org_acme/projects/missing/integrations/discover?capability=errors")).status,
    ).toBe(404);
    expect(
      (
        await normal.app.request(provisionPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(provisioner.calls).toBe(0);
  });
});

describe("multi-account integration selection", () => {
  it("uses collision-free per-account secrets and refuses provider I/O until selection", async () => {
    const database = new RouteDatabase();
    const secrets = new InMemorySecretStore();
    const provisioner = new RecordingProvisioner();
    const { app } = harness({ actor: admin, database, secrets, provisioner });

    for (const account of ["team_a", "team_b"]) {
      const response = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: `token_${account}`, upstreamAccountId: account, authKind: "api_key" }),
      });
      expect(response.status).toBe(201);
    }
    const refs = database.memory.connections.map((row) => row.credential_ref);
    expect(new Set(refs).size).toBe(2);
    await expect(secrets.get(refs[0]!)).resolves.toMatchObject({ value: "token_team_a" });
    await expect(secrets.get(refs[1]!)).resolves.toMatchObject({ value: "token_team_b" });

    const memberApp = harness({ actor: member, database, secrets, provisioner }).app;
    const ambiguous = await memberApp.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
    );
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ status: "selection_required", reason: "multiple_eligible" });
    expect(provisioner.calls).toBe(0);

    const accountB = database.memory.connections.find((row) => row.upstream_account_id === "team_b")!;
    const grantB = database.memory.grants.find((row) => row.connection_id === accountB.id)!;
    const selected = await memberApp.request("/orgs/org_acme/projects/proj_1/integrations/deploy.vercel/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: accountB.id, grantId: grantB.id }),
    });
    expect(selected.status).toBe(200);

    const discovered = await memberApp.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
    );
    expect(discovered.status).toBe(200);
    expect(provisioner.grants.at(-1)).toMatchObject({
      connectionId: accountB.id,
      grantId: grantB.id,
      upstreamAccountId: "team_b",
    });
  });

  it("returns a structured not-linked result without constructing a provider", async () => {
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

  it("lists the exact selected account and lifecycle state without secret refs", async () => {
    const database = new RouteDatabase();
    const { app } = harness({ actor: admin, database });
    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret-value", upstreamAccountId: "sentry_acme", authKind: "api_key" }),
    });
    const linked = (await link.json()) as { connectionId: string; grantId: string };
    const memberApp = harness({ actor: member, database }).app;
    await memberApp.request("/orgs/org_acme/projects/proj_1/integrations/sentry/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: linked.connectionId, grantId: linked.grantId }),
    });
    const response = await memberApp.request("/orgs/org_acme/integrations?projectId=proj_1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      integrations: [{ providerKind: "sentry", selectedForProject: true }],
      lifecycle: { projectId: "proj_1", requirements: { total: 2, needsAttention: 1 } },
    });
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("credentialRef");
  });
});
