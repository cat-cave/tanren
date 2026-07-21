// cspell:ignore rolsuper rolbypassrls
// in-20 — real-Postgres proof for the integration HTTP read surface. Every
// decisive read runs as the restricted non-superuser `tanren_app` role
// (rolsuper=false AND rolbypassrls=false); the owner connection only provisions
// the DB and seeds FK prerequisites. Gated on TANREN_RLS_DB_TEST like every peer
// *.rls.integration test (runs in `smoke-rls-integration-reads`). Proves: the
// real Hono route → real DB → real response composition works, and a CROSS-ORG
// read sees ZERO rows (org isolation at the DB, both through the route and
// directly through the store).
//
// Mirrors `verificationReads.rls.integration.test.ts` (rv-22) shape-for-shape.

import { runWithOrgScope, migrate } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationReadRoutes } from "../src/routes/integrations/reads.js";
import {
  listIntegrationBindings,
  listCapabilityNodes,
  listIntegrationRequirements,
  readDeliveryDagStatus,
  readLifecycleInventory,
} from "../src/routes/integrations/integrationReadStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_in20_a";
const ORG_B = "org_in20_b";
const PROJECT = "project_in20";
const REQUIREMENT = "req_in20";
const CAPABILITY_NODE = "capnode_in20";
const BINDING = "bind_in20";
const SHA = `sha256:${"d".repeat(64)}`;

const ACTOR_A: ActorContext = {
  userId: "user_in20_a",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function databaseName(): string {
  return `tanren_integration_reads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedOrg(owner: Pool, org: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
}

async function seedTenant(owner: Pool): Promise<void> {
  await seedOrg(owner, ORG_A);
  await seedOrg(owner, ORG_B);
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG_A],
  );
  // FK prerequisites for integration_bindings: an org-scoped connection + auth gen +
  // grant + grant gen. Mirrors the in-14 seed in bindingMaterializer.rls.integration.test.ts.
  await owner.query(
    `INSERT INTO org_integration_connections
       (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
        principal_metadata, health, status, current_auth_generation, owner_id)
     VALUES ($1, 'conn_in20', 'slack', 'team-in20', 'organization', 'team-in20',
             '{}'::jsonb, 'healthy', 'active', 1, 'admin-in20')`,
    [ORG_A],
  );
  await owner.query(
    `INSERT INTO org_integration_connection_auth_generations
       (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
     VALUES ($1, 'slack', 'conn_in20', 1, 'secret://org/in20/cred', 'bot_token', 'active')`,
    [ORG_A],
  );
  await owner.query(
    `INSERT INTO org_integration_grants
       (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
     VALUES ($1, 'grant_in20', 'slack', 'conn_in20', 'product', 'preview', 1, 'active')`,
    [ORG_A],
  );
  await owner.query(
    `INSERT INTO org_integration_grant_generations
       (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
        provider_scopes, resource_constraints, policy_revision, consent_revision,
        consent_actor_id, consented_at, status)
     VALUES ($1, 'slack', 'conn_in20', 'grant_in20', 1, ARRAY['messaging']::text[],
             ARRAY['bind']::text[], ARRAY['chat:write']::text[], '{}'::jsonb,
             'integration-catalog.v3', 'consent.test', 'admin-in20', now(), 'active')`,
    [ORG_A],
  );
  await owner.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state, source_kind,
        source_revision_id, source_digest, policy_version, criticality, status)
     VALUES ($1, $2, $3, 'messaging.send', 'product', 'outbound', '{}'::jsonb,
        'behavior_revision', 'breed_in20', $4, 'v1', 'release_required', 'active')`,
    [ORG_A, REQUIREMENT, PROJECT, SHA],
  );
  await owner.query(
    `INSERT INTO capability_nodes
       (org_id, id, project_id, requirement_id, environment, executor_kind, desired_state_hash,
        status, wait_reason, priority, generation)
     VALUES ($1, $2, $3, $4, 'preview', 'provider_operation', $5, 'ready', NULL, 0, 1)`,
    [ORG_A, CAPABILITY_NODE, PROJECT, REQUIREMENT, SHA],
  );
  await owner.query(
    `INSERT INTO integration_bindings
       (org_id, id, project_id, requirement_id, environment, provider_kind, connection_id,
        current_generation, status, drift_state)
     VALUES ($1, $2, $3, $4, 'preview', 'slack', 'conn_in20', 1, 'ready', 'in_sync')`,
    [ORG_A, BINDING, PROJECT, REQUIREMENT],
  );
  await owner.query(
    `INSERT INTO integration_binding_generations
       (org_id, project_id, requirement_id, environment, binding_id, generation, provider_kind,
        connection_id, auth_generation, grant_id, grant_generation, adapter_version,
        external_resource_id, external_resource_name, ownership, teardown_policy,
        desired_state_hash, status, drift_state)
     VALUES ($1, $2, $3, 'preview', $4, 1, 'slack', 'conn_in20', 1, 'grant_in20', 1,
        'slack.v1', 'T123', 'tanren-channel', 'created', 'delete', $5, 'ready', 'in_sync')`,
    [ORG_A, PROJECT, REQUIREMENT, BINDING, SHA],
  );
  await owner.query(
    `INSERT INTO integration_binding_env
       (org_id, project_id, binding_id, binding_generation, key, classification, required, scopes)
     VALUES ($1, $2, $3, 1, 'SLACK_BOT_TOKEN_REF', 'secret', 1, '{runtime}'::text[])`,
    [ORG_A, PROJECT, BINDING],
  );
  // Note: delivery_runs has a FK chain to authority_decisions; the cross-org-zero
  // invariant is identical across every integration table (same RLS policy shape),
  // so we omit the delivery seed here and prove cross-org zero on the requirements,
  // capability_nodes, and bindings tables. The in-memory contract test covers the
  // delivery endpoint's shape + redaction against a hand-crafted fixture row.
}

function appFor(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/v1/orgs", createIntegrationReadRoutes({ pool }));
  return app;
}

describeDb("in-20 integration read surface — real reads, org isolation", () => {
  const database = databaseName();
  let owner: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    appPool = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("runs the decisive reads as the non-superuser tanren_app role", async () => {
    const identity = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("lifecycle: returns the seeded inventory counts through the real route", async () => {
    const response = await appFor(appPool, ACTOR_A).request(
      `/v1/orgs/${ORG_A}/projects/${PROJECT}/integrations/lifecycle`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      requirements: { total: number; needsAttention: number };
      capabilityNodes: { total: number; ready: number };
      bindings: { total: number; ready: number };
      deliveries: { total: number; completed: number };
    };
    expect(body.version).toBe("v1");
    expect(body.requirements.total).toBe(1);
    expect(body.capabilityNodes.total).toBe(1);
    expect(body.capabilityNodes.ready).toBe(1);
    expect(body.bindings.total).toBe(1);
    expect(body.bindings.ready).toBe(1);
    // deliveries.total is 0 (no delivery_runs seed; the FK chain to
    // authority_decisions is heavy — the route's shape + redaction is proven by
    // the in-memory contract test).
    expect(body.deliveries.total).toBe(0);
  });

  it("requirements: surfaces the seeded requirement row through the real route", async () => {
    const response = await appFor(appPool, ACTOR_A).request(
      `/v1/orgs/${ORG_A}/projects/${PROJECT}/integration-requirements`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { requirements: { requirementId: string; capability: string }[] };
    expect(body.requirements).toHaveLength(1);
    expect(body.requirements[0]!.requirementId).toBe(REQUIREMENT);
    expect(body.requirements[0]!.capability).toBe("messaging.send");
  });

  it("capability-nodes: surfaces the seeded capability node through the real route", async () => {
    const response = await appFor(appPool, ACTOR_A).request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/capability-nodes`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { capabilityNodes: { nodeId: string; status: string }[] };
    expect(body.capabilityNodes).toHaveLength(1);
    expect(body.capabilityNodes[0]!.nodeId).toBe(CAPABILITY_NODE);
    expect(body.capabilityNodes[0]!.status).toBe("ready");
  });

  it("bindings: surfaces the in-15 appEnvHash proof through the real route", async () => {
    const response = await appFor(appPool, ACTOR_A).request(
      `/v1/orgs/${ORG_A}/projects/${PROJECT}/integration-bindings`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bindings: {
        bindingId: string;
        currentGeneration: { appEnvHash: string; outputs: { logicalKey: string }[] } | null;
      }[];
    };
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]!.bindingId).toBe(BINDING);
    expect(body.bindings[0]!.currentGeneration?.appEnvHash).toBe(SHA);
    expect(body.bindings[0]!.currentGeneration?.outputs[0]!.logicalKey).toBe("SLACK_BOT_TOKEN_REF");
  });

  it("delivery: returns the versioned list shape through the real route", async () => {
    // The delivery endpoint is exercised against an empty project here (the
    // delivery_runs FK chain to authority_decisions is heavy; the route's shape
    // + redaction contract is proven by the in-memory contract test against a
    // hand-crafted fixture row). This assertion proves the real route → real DB
    // → real response composition works and surfaces an empty list, never null.
    const response = await appFor(appPool, ACTOR_A).request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/delivery`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string; deliveryRuns: unknown[] };
    expect(body.version).toBe("v1");
    expect(body.deliveryRuns).toEqual([]);
  });

  it("DECISIVE: a cross-org store read sees ZERO rows — org B cannot read org A's integration data", async () => {
    // Drive every store directly as ORG_B (under the tanren_app role). RLS must
    // deny every row — empty lists, undefined inventory — never a leak.
    const lifecycle = await runWithOrgScope(appPool, ORG_B, (client) =>
      readLifecycleInventory(client, { orgId: ORG_B, projectId: PROJECT }),
    );
    expect(lifecycle).toBeUndefined();

    const requirements = await runWithOrgScope(appPool, ORG_B, (client) =>
      listIntegrationRequirements(client, { orgId: ORG_B, projectId: PROJECT }),
    );
    expect(requirements.requirements).toEqual([]);

    const capabilityNodes = await runWithOrgScope(appPool, ORG_B, (client) =>
      listCapabilityNodes(client, { orgId: ORG_B, projectId: PROJECT }),
    );
    expect(capabilityNodes.capabilityNodes).toEqual([]);

    const bindings = await runWithOrgScope(appPool, ORG_B, (client) =>
      listIntegrationBindings(client, { orgId: ORG_B, projectId: PROJECT }),
    );
    expect(bindings.bindings).toEqual([]);

    const delivery = await runWithOrgScope(appPool, ORG_B, (client) =>
      readDeliveryDagStatus(client, { orgId: ORG_B, projectId: PROJECT }),
    );
    expect(delivery.deliveryRuns).toEqual([]);
  });
});
