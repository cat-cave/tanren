/**
 * Real-Postgres former-bug proof for exact operation authority.
 * Opt-in: TANREN_RLS_DB_TEST=1 with a reachable owner DATABASE_URL.
 */
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationCatalogRevision } from "../src/engine/contracts/integrationCatalog.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import { secretValueForDeployOperation } from "../src/engine/provisioners/deployOperationAuthority.js";
import { IntegrationConnectionsStore } from "../src/engine/repositories/integrationConnections.js";
import { systemActor } from "../src/engine/state/actor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const ORG_ID = "org_exact_operation";
const PROJECT_ID = "project_exact_operation";
const CONNECTION_ID = "connection_exact_operation";
const GRANT_ID = "grant_exact_operation";
const CREDENTIAL_REF = "secret://org/exact/integration/deploy.vercel/connection/exact/token/g/1";
const DEPLOY_TARGET = {
  resourceId: "app-allowed",
  sourceRepo: "cat-cave/product",
  sourceRef: "merge-sha",
} as const;

function databaseName(): string {
  return `tanren_exact_operation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("IN-1 exact operation authority — real PostgreSQL", () => {
  const dbName = databaseName();
  const authority = new PgIntegrationAuthority();
  let owner: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, dbName) });
    await migrate(owner);

    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, 'exact-org', 'Exact Org', '{"version":1}'::jsonb)`,
      [ORG_ID],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'Exact Project', 'https://example.com/exact.git', $2)`,
      [PROJECT_ID, ORG_ID],
    );
    await runWithOrgScope(owner, ORG_ID, async (client) => {
      await client.query(
        `INSERT INTO org_integration_connections
           (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
            principal_metadata, health, status, current_auth_generation, owner_id)
         VALUES ($1, $2, 'deploy.vercel', 'team-exact', 'team', 'Exact Team',
                 '{"teamId":"team-exact"}'::jsonb, 'healthy', 'active', 1, 'admin')`,
        [ORG_ID, CONNECTION_ID],
      );
      await client.query(
        `INSERT INTO org_integration_connection_auth_generations
           (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
         VALUES ($1, 'deploy.vercel', $2, 1, $3, 'api_key', 'active')`,
        [ORG_ID, CONNECTION_ID, CREDENTIAL_REF],
      );
      await client.query(
        `INSERT INTO org_integration_grants
           (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
         VALUES ($1, $2, 'deploy.vercel', $3, 'control', 'control', 1, 'active')`,
        [ORG_ID, GRANT_ID, CONNECTION_ID],
      );
      await client.query(
        `INSERT INTO org_integration_grant_generations
           (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
            provider_scopes, resource_constraints, policy_revision, consent_revision,
            consent_actor_id, consented_at, status)
         VALUES ($1, 'deploy.vercel', $2, $3, 1, ARRAY['deploy'],
                 ARRAY['deploy','verify'], ARRAY[]::text[], $4::jsonb, $5,
                 'consent.exact', 'admin', now(), 'active')`,
        [
          ORG_ID,
          CONNECTION_ID,
          GRANT_ID,
          JSON.stringify({
            version: 1,
            projectBinding: "selected",
            resourceIds: [DEPLOY_TARGET.resourceId],
            environments: ["production"],
          }),
          integrationCatalogRevision(),
        ],
      );
      const selected = await IntegrationConnectionsStore.selectControlGrant(
        client,
        {
          orgId: ORG_ID,
          projectId: PROJECT_ID,
          providerKind: "deploy.vercel",
          connectionId: CONNECTION_ID,
          grantId: GRANT_ID,
          authGeneration: 1,
          grantGeneration: 1,
        },
        systemActor,
      );
      if (selected?.connectionId !== CONNECTION_ID || selected.grantId !== GRANT_ID) {
        throw new Error("exact operation fixture selection failed");
      }
    });
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }, 30_000);

  const authorize = (target = DEPLOY_TARGET) =>
    runWithOrgScope(owner, ORG_ID, (client) =>
      authority.authorizeOperation(client, {
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        providerKind: "deploy.vercel",
        capability: "deploy",
        operation: "deploy",
        target,
        actor: systemActor,
      }),
    );

  it("issues only the selected exact resource and blocks operation reuse or revocation before secret I/O", async () => {
    const authorized = await authorize();
    expect(authorized.status).toBe("eligible");
    if (authorized.status !== "eligible") return;
    const grant = IntegrationConnectionsStore.orgGrantFromLease(authorized.lease);
    const base = new InMemorySecretStore();
    await base.put({ ref: CREDENTIAL_REF, value: "provider-token" });
    const getSpy = vi.spyOn(base, "get");

    await expect(secretValueForDeployOperation(base, "deploy.vercel", grant, "deploy", DEPLOY_TARGET)).resolves.toBe(
      "provider-token",
    );
    getSpy.mockClear();

    await expect(
      secretValueForDeployOperation(base, "deploy.vercel", grant, "verify", {
        resourceId: DEPLOY_TARGET.resourceId,
        deploymentId: "deployment-1",
      }),
    ).rejects.toThrow(/binding mismatch/u);
    expect(getSpy).not.toHaveBeenCalled();

    const denied = await authorize({ ...DEPLOY_TARGET, resourceId: "app-denied" });
    expect(denied).toMatchObject({
      status: "selection_required",
      candidates: [{ ineligibilityReasons: expect.arrayContaining(["resource_not_allowed"]) }],
    });

    await runWithOrgScope(owner, ORG_ID, (client) =>
      client.query(
        `UPDATE org_integration_grant_generations SET status = 'revoked'
         WHERE org_id = $1 AND connection_id = $2 AND grant_id = $3 AND generation = 1`,
        [ORG_ID, CONNECTION_ID, GRANT_ID],
      ),
    );
    const revoked = await authorize();
    expect(revoked).toMatchObject({
      status: "selection_required",
      candidates: [{ ineligibilityReasons: expect.arrayContaining(["grant_generation_not_active"]) }],
    });
    expect(getSpy).not.toHaveBeenCalled();
  }, 60_000);
});
