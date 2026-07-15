// cspell:ignore relforcerowsecurity relnamespace schemaname nspname tablename
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppEnvironmentStore } from "../src/engine/repositories/appEnvironment.js";
import { IntegrationConnectionsStore } from "../src/engine/repositories/integrationConnections.js";
import { systemActor } from "../src/engine/state/actor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_in_lifecycle_a";
const ORG_B = "org_in_lifecycle_b";
const PROJECT_A = "project_in_lifecycle_a";
const PROJECT_B = "project_in_lifecycle_b";
const DIGEST = `sha256:${"a".repeat(64)}`;
const LIFECYCLE_TABLES = [
  "behavior_integration_requirements",
  "capability_node_dependencies",
  "capability_nodes",
  "delivery_runs",
  "delivery_stage_attempts",
  "integration_binding_env",
  "integration_bindings",
  "integration_reconciliations",
  "integration_requirements",
  "integration_resource_snapshots",
  "integration_validation_proofs",
  "org_integration_connections",
  "org_integration_grants",
  "project_app_env",
  "project_integration_grant_selections",
  "spec_capability_dependencies",
] as const;

function dbName(): string {
  return `tanren_in_lifecycle_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("IN-1 lifecycle authority — real Postgres RLS and tenant FKs", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  let connectionA = "";
  let connectionB = "";
  let grantA = "";
  let grantB = "";

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);

    const linkedA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IntegrationConnectionsStore.linkControlGrant(
        client,
        {
          orgId: ORG_A,
          providerKind: "sentry",
          upstreamAccountId: "account-a",
          authKind: "api_key",
          credentialRef: "secret://org-a/sentry",
          capabilities: ["errors"],
        },
        systemActor,
      ),
    );
    connectionA = linkedA.connectionId;
    grantA = linkedA.grantId;

    const linkedB = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      IntegrationConnectionsStore.linkControlGrant(
        client,
        {
          orgId: ORG_B,
          providerKind: "sentry",
          upstreamAccountId: "account-b",
          authKind: "api_key",
          credentialRef: "secret://org-b/sentry",
          capabilities: ["errors"],
        },
        systemActor,
      ),
    );
    connectionB = linkedB.connectionId;
    grantB = linkedB.grantId;

    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IntegrationConnectionsStore.selectControlGrant(
        client,
        {
          orgId: ORG_A,
          projectId: PROJECT_A,
          providerKind: "sentry",
          connectionId: connectionA,
          grantId: grantA,
        },
        systemActor,
      ),
    );
    await runWithOrgScope(runtimePool, ORG_B, (client) =>
      IntegrationConnectionsStore.selectControlGrant(
        client,
        {
          orgId: ORG_B,
          projectId: PROJECT_B,
          providerKind: "sentry",
          connectionId: connectionB,
          grantId: grantB,
        },
        systemActor,
      ),
    );

    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await client.query(
        `INSERT INTO integration_requirements
           (org_id, id, project_id, capability, plane, direction, desired_state,
            source_kind, source_revision_id, source_digest, policy_version, criticality)
         VALUES ($1, 'requirement-a', $2, 'errors', 'product', 'outbound', '{}'::jsonb,
                 'design_contract', 'design-a', $3, 'policy-v1', 'release_required')`,
        [ORG_A, PROJECT_A, DIGEST],
      );
      await client.query(
        `INSERT INTO integration_bindings
           (org_id, id, project_id, requirement_id, grant_id, environment,
            provider_kind, adapter_version, external_resource_id, external_resource_name,
            ownership, teardown_policy, desired_state_hash)
         VALUES ($1, 'binding-a', $2, 'requirement-a', $3, 'production',
                 'sentry', 'v1', 'external-a', 'errors-a', 'created', 'delete', $4)`,
        [ORG_A, PROJECT_A, grantA, DIGEST],
      );
      await AppEnvironmentStore.upsert(
        client,
        {
          orgId: ORG_A,
          projectId: PROJECT_A,
          environment: "production",
          key: "PUBLIC_URL",
          plainValue: "https://a.example",
          scopes: ["runtime"],
        },
        systemActor,
      );
    });
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("is deny-by-default unscoped and returns only the scoped tenant", async () => {
    const unscopedConnections = await runtimePool.query("SELECT id FROM org_integration_connections");
    const unscopedBindings = await runtimePool.query("SELECT id FROM integration_bindings");
    const unscopedEnv = await runtimePool.query("SELECT id FROM project_app_env");
    expect(unscopedConnections.rowCount).toBe(0);
    expect(unscopedBindings.rowCount).toBe(0);
    expect(unscopedEnv.rowCount).toBe(0);

    const seenA = await runWithOrgScope(runtimePool, ORG_A, async (client) => ({
      connections: await client.query<{ id: string }>("SELECT id FROM org_integration_connections"),
      grants: await client.query<{ id: string }>("SELECT id FROM org_integration_grants"),
      bindings: await client.query<{ id: string }>("SELECT id FROM integration_bindings"),
      env: await client.query<{ key: string }>("SELECT key FROM project_app_env"),
    }));
    expect(seenA.connections.rows.map((row) => row.id)).toEqual([connectionA]);
    expect(seenA.grants.rows.map((row) => row.id)).toEqual([grantA]);
    expect(seenA.bindings.rows.map((row) => row.id)).toEqual(["binding-a"]);
    expect(seenA.env.rows.map((row) => row.key)).toEqual(["PUBLIC_URL"]);

    const bFromA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query("SELECT id FROM org_integration_connections WHERE id = $1", [connectionB]),
    );
    expect(bFromA.rowCount).toBe(0);
  });

  it("enables and forces the exact policy on every lifecycle table", async () => {
    const catalog = await ownerPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policy_count: string;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, count(p.policyname)::text AS policy_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
       ORDER BY c.relname`,
      [[...LIFECYCLE_TABLES]],
    );
    expect(catalog.rows).toHaveLength(LIFECYCLE_TABLES.length);
    expect(catalog.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(catalog.rows.every((row) => row.policy_count === "1")).toBe(true);
  });

  it("rejects an org-spoofed connection write through the real policy", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        IntegrationConnectionsStore.linkControlGrant(
          client,
          {
            orgId: ORG_B,
            providerKind: "slack",
            upstreamAccountId: "spoofed",
            authKind: "bot_token",
            credentialRef: "secret://spoofed",
            capabilities: ["notify"],
          },
          systemActor,
        ),
      ),
    ).rejects.toThrow(/row-level security/u);
  });

  it("rejects cross-org connection, project, and binding references", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        client.query(
          `INSERT INTO org_integration_grants
             (org_id, id, connection_id, plane, environment, policy_revision, consent_revision)
           VALUES ($1, 'grant-cross-org', $2, 'control', 'control', 'p1', 'c1')`,
          [ORG_A, connectionB],
        ),
      ),
    ).rejects.toThrow(/foreign key/u);

    const crossSelection = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IntegrationConnectionsStore.selectControlGrant(
        client,
        {
          orgId: ORG_A,
          projectId: PROJECT_A,
          providerKind: "sentry",
          connectionId: connectionB,
          grantId: grantB,
        },
        systemActor,
      ),
    );
    expect(crossSelection).toBeUndefined();

    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        AppEnvironmentStore.upsert(
          client,
          {
            orgId: ORG_A,
            projectId: PROJECT_B,
            environment: "production",
            key: "CROSS_ORG",
            plainValue: "blocked",
            scopes: ["runtime"],
          },
          systemActor,
        ),
      ),
    ).rejects.toThrow(/foreign key/u);

    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        client.query(
          `INSERT INTO integration_bindings
             (org_id, id, project_id, requirement_id, grant_id, environment,
              provider_kind, adapter_version, external_resource_id, external_resource_name,
              ownership, teardown_policy, desired_state_hash, generation)
           VALUES ($1, 'binding-cross-org', $2, 'requirement-a', $3, 'production',
                   'sentry', 'v1', 'external-b', 'errors-b', 'created', 'delete', $4, 2)`,
          [ORG_A, PROJECT_A, grantB, DIGEST],
        ),
      ),
    ).rejects.toThrow(/foreign key/u);
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [projectId, orgId],
  );
}
