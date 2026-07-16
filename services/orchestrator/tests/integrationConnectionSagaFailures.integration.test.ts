import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrincipalCandidate } from "../src/engine/contracts/integrationAuthority.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import { integrationRequestFingerprint } from "../src/engine/integrations/integrationOperationFingerprint.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import type { LinkReservation } from "../src/engine/repositories/integrationConnectionFinalize.js";
import { finalizeReservedSecret } from "../src/engine/repositories/integrationConnectionFinalize.js";
import { IntegrationConnectionsStore } from "../src/engine/repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import type { IntegrationAuthorityRouteDatabase } from "../src/routes/integrations/authorityWrites.js";
import { runDurableLinkSaga } from "../src/routes/integrations/linkSaga.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const PRINCIPAL: PrincipalCandidate = {
  providerPrincipalId: "stable-team",
  principalKind: "team",
  displayName: "Stable Team",
  metadata: { slug: "stable-team" },
};
const verified = { principal: PRINCIPAL, authKind: "api_key", scopes: [] as string[] };

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

class SagaDatabase implements IntegrationAuthorityRouteDatabase {
  readonly events = new FakeEventStore();
  constructor(private readonly pool: Pool) {}
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T> {
    return runWithOrgScope(this.pool, orgId, work);
  }
}

describeDb("IN-1 saga terminal conflicts and stable relink — real PostgreSQL", () => {
  const dbName = `tanren_in_saga_failures_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const authority = new PgIntegrationAuthority();
  let owner: Pool;
  let database: SagaDatabase;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, dbName) });
    await migrate(owner);
    database = new SagaDatabase(owner);
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

  async function seedOrg(orgId: string): Promise<void> {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [orgId],
    );
  }

  async function createOperation(orgId: string, key: string, token: string) {
    const requestFingerprint = integrationRequestFingerprint({
      orgId,
      providerKind: "deploy.vercel",
      operationKind: "link",
      actorId: "admin",
      credential: token,
    });
    const permit = await database.withOrgScope(orgId, (client) =>
      authority.authorizePrincipalVerification(client, {
        orgId,
        providerKind: "deploy.vercel",
        operationKind: "link",
        idempotencyKey: key,
        requestFingerprint,
        actor: { kind: "operator", id: "admin" },
      }),
    );
    return { permit, staged: { handle: permit.stagedSecretHandle, operationId: permit.operationId } };
  }

  async function reserve(
    orgId: string,
    token: string,
    key: string,
    secrets: GenerationAddressedIntegrationSecretStore,
  ) {
    const operation = await createOperation(orgId, key, token);
    await secrets.stage(operation.permit.operationId, token);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markOperationStaged(
        client,
        orgId,
        operation.permit.operationId,
        operation.staged.handle,
      ),
    );
    const state = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.reserveVerifiedLink(client, { ...operation, ...verified }),
    );
    return { operation, reservation: state as LinkReservation };
  }

  async function activate(
    orgId: string,
    operation: Awaited<ReturnType<typeof createOperation>>,
    reservation: LinkReservation,
    secrets: GenerationAddressedIntegrationSecretStore,
  ) {
    const credentialRef = await finalizeReservedSecret(secrets, reservation, operation.staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markReservationActivatePending(client, reservation, credentialRef),
    );
    return database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.activateReservedLink(client, reservation, credentialRef),
    );
  }

  it("links a revoked principal again on its stable connection with the next exact generations", async () => {
    const orgId = "org_saga_relink";
    await seedOrg(orgId);
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const first = await reserve(orgId, "first-token", "first-link", secrets);
    const linked = await activate(orgId, first.operation, first.reservation, secrets);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.revoke(client, orgId, linked.connectionId, { kind: "operator", id: "admin" }),
    );

    const second = await reserve(orgId, "second-token", "second-link", secrets);
    expect(second.reservation).toMatchObject({
      connectionId: linked.connectionId,
      grantId: linked.grantId,
      nextGeneration: 2,
      grantGeneration: 2,
    });
    const relinked = await activate(orgId, second.operation, second.reservation, secrets);
    expect(relinked).toMatchObject({ connectionId: linked.connectionId, authGeneration: 2, grantGeneration: 2 });
    const rows = await owner.query(
      `SELECT c.id, c.status, c.current_auth_generation, g.current_generation, g.status AS grant_status
       FROM org_integration_connections c JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id WHERE c.org_id = $1`,
      [orgId],
    );
    expect(rows.rows).toEqual([
      {
        id: linked.connectionId,
        status: "active",
        current_auth_generation: 2,
        current_generation: 2,
        grant_status: "active",
      },
    ]);
  }, 60_000);

  it("terminalizes a permanent activation conflict without deleting the confirmed generation", async () => {
    const orgId = "org_saga_activation_conflict";
    await seedOrg(orgId);
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const { operation, reservation } = await reserve(orgId, "conflict-token", "conflict-link", secrets);
    const credentialRef = await finalizeReservedSecret(secrets, reservation, operation.staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markReservationActivatePending(client, reservation, credentialRef),
    );
    await owner.query(
      `INSERT INTO org_integration_connections
         (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
          health, status, owner_id)
       VALUES ($1, $2, 'deploy.vercel', 'conflicting-team', 'team', 'Conflicting Team',
               'healthy', 'active', 'admin')`,
      [orgId, reservation.connectionId],
    );

    const outcome = await runDurableLinkSaga(database, orgId, secrets, {
      permit: operation.permit,
      staged: operation.staged,
      credential: "conflict-token",
    });
    expect(outcome).toEqual({ status: "failed", reason: "activation_conflict" });
    expect(await base.get(credentialRef)).toBeDefined();
    expect(await base.get(operation.staged.handle)).toBeUndefined();
    const op = await owner.query(
      `SELECT stage, status, failure_classification, staged_secret_handle
       FROM org_integration_connection_operations WHERE org_id = $1 AND id = $2`,
      [orgId, operation.permit.operationId],
    );
    expect(op.rows[0]).toEqual({
      stage: "failed",
      status: "failed",
      failure_classification: "activation_permanent_conflict",
      staged_secret_handle: null,
    });

    const retry = await reserve(orgId, "retry-token", "retry-link", secrets);
    expect(retry.reservation.principal.providerPrincipalId).toBe(PRINCIPAL.providerPrincipalId);
  }, 60_000);
});
