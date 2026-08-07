import { Hono } from "hono";
import { vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type {
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../src/engine/contracts/integrationProvisioner.js";
import { InMemorySecretStore, type SecretStore } from "../src/engine/contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import type { IntegrationQueryClient, IntegrationQueryResult } from "../src/engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationRoutes, type IntegrationRouteDatabase } from "../src/routes/integrations/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { IntegrationMemoryDb } from "./helpers/integrationMemoryDb.js";

export const member: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: "proj_1",
  scopes: ["org:member", "project:member"],
  source: "session",
};
export const admin: ActorContext = { ...member, projectId: null, scopes: ["org:admin"] };

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
    if (sql === "SELECT login FROM organizations WHERE id = $1") {
      const [orgId] = params as [string];
      const found = orgId === this.orgId;
      return { rows: found ? [{ login: "acme" }] : [], rowCount: found ? 1 : 0 };
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

export class RouteDatabase implements IntegrationRouteDatabase {
  readonly events = new FakeEventStore();
  readonly memory = new IntegrationMemoryDb();
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T> {
    return work(new RouteClient(this.memory.clientForOrg(orgId), orgId, new Set(["user_alice"])));
  }
}

export class RecordingProvisioner implements IntegrationProvisioner {
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

export function harness(input: {
  actor: ActorContext;
  database?: RouteDatabase;
  secrets?: SecretStore;
  provisioner?: RecordingProvisioner;
  buildProvisioner?: (kind: string) => IntegrationProvisioner;
  integrationSecrets?: GenerationAddressedIntegrationSecretStore;
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
      integrationSecrets: input.integrationSecrets ?? new GenerationAddressedIntegrationSecretStore(secrets),
      buildProvisioner: input.buildProvisioner ?? (() => provisioner),
      fetchImpl: input.fetchImpl,
    }),
  );
  return { app, database, secrets, provisioner };
}

export function vercelFetchFor(teamId: string): typeof fetch {
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

export const provisionPath = "/orgs/org_acme/projects/proj_1/integrations/provision";
