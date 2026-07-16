import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IntegrationIdempotencyConflictError,
  type PrincipalCandidate,
} from "../src/engine/contracts/integrationAuthority.js";
import type { PutCreateOnlyResult, SecretValue } from "../src/engine/contracts/secretStore.js";
import { InMemorySecretStore, SecretStoreWriteError } from "../src/engine/contracts/secretStore.js";
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
  providerPrincipalId: "team-live",
  principalKind: "team",
  displayName: "Live Team",
  metadata: { slug: "live-team" },
};

function databaseName(): string {
  return `tanren_in_saga_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

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

class ToggleWriteStore extends InMemorySecretStore {
  mode: "ok" | "definite" | "unknown" = "ok";

  override async putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult> {
    if (this.mode !== "ok") {
      throw new SecretStoreWriteError(
        "injected Vault write failure",
        this.mode === "definite" ? "definitely_unwritten" : "unknown",
      );
    }
    return super.putCreateOnly(secret);
  }
}

describeDb("IN-1 durable integration connection saga — real PostgreSQL", () => {
  const dbName = databaseName();
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

  async function createStagedOperation(
    orgId: string,
    key: string,
    token: string,
    operationKind: "link" | "rotate" = "link",
    connectionId?: string,
  ) {
    const fingerprint = integrationRequestFingerprint({
      orgId,
      providerKind: "deploy.vercel",
      operationKind,
      ...(connectionId === undefined ? {} : { connectionId }),
      actorId: "admin",
      credential: token,
    });
    const permit = await database.withOrgScope(orgId, (client) =>
      authority.authorizePrincipalVerification(client, {
        orgId,
        providerKind: "deploy.vercel",
        operationKind,
        ...(connectionId === undefined ? {} : { connectionId }),
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        actor: { kind: "operator", id: "admin" },
      }),
    );
    return { permit, fingerprint, staged: { handle: permit.stagedSecretHandle, operationId: permit.operationId } };
  }

  async function persistStage(
    orgId: string,
    token: string,
    input: Awaited<ReturnType<typeof createStagedOperation>>,
    secrets: GenerationAddressedIntegrationSecretStore,
  ): Promise<void> {
    await secrets.stage(input.permit.operationId, token);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markOperationStaged(client, orgId, input.permit.operationId, input.staged.handle),
    );
  }

  const verified = { principal: PRINCIPAL, authKind: "api_key", scopes: [] as string[] };

  it("rolls back reserve/activation crashes and resumes the exact Vault-confirmed reservation", async () => {
    const orgId = "org_saga_crash";
    const token = "token-crash";
    await seedOrg(orgId);
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const operation = await createStagedOperation(orgId, "crash-key", token);
    await persistStage(orgId, token, operation, secrets);

    await expect(
      database.withOrgScope(orgId, async (client) => {
        await IntegrationConnectionsStore.reserveVerifiedLink(client, {
          permit: operation.permit,
          staged: operation.staged,
          ...verified,
        });
        throw new Error("injected_reserve_process_death");
      }),
    ).rejects.toThrow("injected_reserve_process_death");
    expect((await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [orgId])).rowCount).toBe(
      0,
    );

    const reserved = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.reserveVerifiedLink(client, {
        permit: operation.permit,
        staged: operation.staged,
        ...verified,
      }),
    );
    expect("nextGeneration" in reserved).toBe(true);
    const reservation = reserved as LinkReservation;
    expect((await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [orgId])).rowCount).toBe(
      0,
    );

    const credentialRef = await finalizeReservedSecret(secrets, reservation, operation.staged);
    expect(await base.get(operation.staged.handle)).toBeDefined();
    expect(await secrets.getExact({ ref: credentialRef, generation: reservation.nextGeneration })).toBe(token);

    const afterRestart = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.loadDurableLinkState(client, operation.permit),
    );
    expect(afterRestart).toMatchObject({
      connectionId: reservation.connectionId,
      credentialRef,
      nextGeneration: reservation.nextGeneration,
      grantId: reservation.grantId,
      grantGeneration: reservation.grantGeneration,
    });
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markReservationActivatePending(client, reservation, credentialRef),
    );

    await expect(
      database.withOrgScope(orgId, async (client) => {
        await IntegrationConnectionsStore.activateReservedLink(client, reservation, credentialRef);
        throw new Error("injected_activation_process_death");
      }),
    ).rejects.toThrow("injected_activation_process_death");
    expect((await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [orgId])).rowCount).toBe(
      0,
    );

    const linked = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.activateReservedLink(client, reservation, credentialRef),
    );
    await secrets.completeStaged(operation.staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markStagedCleanupComplete(client, operation.permit),
    );
    expect(linked).toMatchObject({ authGeneration: 1, grantGeneration: 1 });
    expect(await base.get(operation.staged.handle)).toBeUndefined();

    const replay = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.loadDurableLinkState(client, operation.permit),
    );
    expect(replay).toMatchObject({ connectionId: linked.connectionId, authGeneration: 1, grantGeneration: 1 });
    const counts = await owner.query<{ connections: string; auth: string; grants: string; grant_generations: string }>(
      `SELECT
         (SELECT count(*) FROM org_integration_connections WHERE org_id = $1)::text AS connections,
         (SELECT count(*) FROM org_integration_connection_auth_generations WHERE org_id = $1)::text AS auth,
         (SELECT count(*) FROM org_integration_grants WHERE org_id = $1)::text AS grants,
         (SELECT count(*) FROM org_integration_grant_generations WHERE org_id = $1)::text AS grant_generations`,
      [orgId],
    );
    expect(counts.rows[0]).toEqual({ connections: "1", auth: "1", grants: "1", grant_generations: "1" });

    const rotatedToken = "token-rotated";
    const rotation = await createStagedOperation(orgId, "rotate-key", rotatedToken, "rotate", linked.connectionId);
    await persistStage(orgId, rotatedToken, rotation, secrets);
    const rotationState = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.reserveVerifiedLink(client, {
        permit: rotation.permit,
        staged: rotation.staged,
        ...verified,
      }),
    );
    const rotationReservation = rotationState as LinkReservation;
    expect(rotationReservation).toMatchObject({
      operationKind: "rotate",
      connectionId: linked.connectionId,
      grantId: linked.grantId,
      nextGeneration: 2,
      grantGeneration: 2,
    });
    const rotatedRef = await finalizeReservedSecret(secrets, rotationReservation, rotation.staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markReservationActivatePending(client, rotationReservation, rotatedRef),
    );
    const rotated = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.activateReservedLink(client, rotationReservation, rotatedRef),
    );
    await secrets.completeStaged(rotation.staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markStagedCleanupComplete(client, rotation.permit),
    );
    expect(rotated).toMatchObject({
      connectionId: linked.connectionId,
      grantId: linked.grantId,
      authGeneration: 2,
      grantGeneration: 2,
    });

    const originalReplayAfterRotation = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.loadDurableLinkState(client, operation.permit),
    );
    expect(originalReplayAfterRotation).toMatchObject({ authGeneration: 1, grantGeneration: 1 });
    const generations = await owner.query(
      `SELECT generation, status FROM org_integration_connection_auth_generations
       WHERE org_id = $1 ORDER BY generation`,
      [orgId],
    );
    expect(generations.rows).toEqual([
      { generation: 1, status: "superseded" },
      { generation: 2, status: "active" },
    ]);

    await expect(
      database.withOrgScope(orgId, (client) =>
        authority.authorizePrincipalVerification(client, {
          orgId,
          providerKind: "deploy.vercel",
          operationKind: "link",
          idempotencyKey: "crash-key",
          requestFingerprint: integrationRequestFingerprint({
            orgId,
            providerKind: "deploy.vercel",
            operationKind: "link",
            actorId: "admin",
            credential: "different-token",
          }),
          actor: { kind: "operator", id: "admin" },
        }),
      ),
    ).rejects.toBeInstanceOf(IntegrationIdempotencyConflictError);
  }, 60_000);

  it("compensates definite Vault failure but preserves and resumes ambiguous failure", async () => {
    const definiteOrg = "org_saga_definite";
    await seedOrg(definiteOrg);
    const definiteBase = new ToggleWriteStore();
    definiteBase.mode = "definite";
    const definiteSecrets = new GenerationAddressedIntegrationSecretStore(definiteBase);
    const definite = await createStagedOperation(definiteOrg, "definite-key", "definite-token");
    await persistStage(definiteOrg, "definite-token", definite, definiteSecrets);
    const failed = await runDurableLinkSaga(database, definiteOrg, definiteSecrets, {
      permit: definite.permit,
      staged: definite.staged,
      credential: "definite-token",
      verified,
    });
    expect(failed).toEqual({ status: "failed", reason: "secret_finalize_failed" });
    expect(await definiteBase.get(definite.staged.handle)).toBeUndefined();
    expect(
      (await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [definiteOrg])).rowCount,
    ).toBe(0);

    const ambiguousOrg = "org_saga_ambiguous";
    await seedOrg(ambiguousOrg);
    const ambiguousBase = new ToggleWriteStore();
    ambiguousBase.mode = "unknown";
    const ambiguousSecrets = new GenerationAddressedIntegrationSecretStore(ambiguousBase);
    const ambiguous = await createStagedOperation(ambiguousOrg, "ambiguous-key", "ambiguous-token");
    await persistStage(ambiguousOrg, "ambiguous-token", ambiguous, ambiguousSecrets);
    const pending = await runDurableLinkSaga(database, ambiguousOrg, ambiguousSecrets, {
      permit: ambiguous.permit,
      staged: ambiguous.staged,
      credential: "ambiguous-token",
      verified,
    });
    expect(pending).toEqual({ status: "finalize_pending" });
    expect(await ambiguousBase.get(ambiguous.staged.handle)).toBeDefined();
    expect(
      (await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [ambiguousOrg])).rowCount,
    ).toBe(0);

    ambiguousBase.mode = "ok";
    const resumed = await runDurableLinkSaga(database, ambiguousOrg, ambiguousSecrets, {
      permit: ambiguous.permit,
      staged: ambiguous.staged,
      credential: "ambiguous-token",
    });
    expect(resumed.status).toBe("completed");
    expect(
      (await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [ambiguousOrg])).rowCount,
    ).toBe(1);
  }, 60_000);

  it("concurrent same-key reserve and activation converge to one exact generation", async () => {
    const orgId = "org_saga_concurrent";
    const token = "concurrent-token";
    await seedOrg(orgId);
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const [left, right] = await Promise.all([
      createStagedOperation(orgId, "same-key", token),
      createStagedOperation(orgId, "same-key", token),
    ]);
    expect(left.permit.operationId).toBe(right.permit.operationId);
    await persistStage(orgId, token, left, secrets);
    const reservations = await Promise.all(
      [left, right].map((operation) =>
        database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.reserveVerifiedLink(client, {
            permit: operation.permit,
            staged: operation.staged,
            ...verified,
          }),
        ),
      ),
    );
    const [first, second] = reservations as [LinkReservation, LinkReservation];
    expect(second).toMatchObject({
      connectionId: first.connectionId,
      credentialRef: first.credentialRef,
      nextGeneration: first.nextGeneration,
      grantId: first.grantId,
      grantGeneration: first.grantGeneration,
    });
    const refs = await Promise.all([
      finalizeReservedSecret(secrets, first, left.staged),
      finalizeReservedSecret(secrets, second, right.staged),
    ]);
    await Promise.all(
      [first, second].map((reservation, index) =>
        database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.markReservationActivatePending(client, reservation, refs[index]!),
        ),
      ),
    );
    const results = await Promise.all(
      [first, second].map((reservation, index) =>
        database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.activateReservedLink(client, reservation, refs[index]!),
        ),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    const rows = await owner.query(
      `SELECT c.current_auth_generation, g.current_generation
       FROM org_integration_connections c JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id
       WHERE c.org_id = $1`,
      [orgId],
    );
    expect(rows.rows).toEqual([{ current_auth_generation: 1, current_generation: 1 }]);
  }, 60_000);

  it("serializes different keys for one principal before either can duplicate the Vault write", async () => {
    const orgId = "org_saga_competing_keys";
    await seedOrg(orgId);
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const operations = await Promise.all([
      createStagedOperation(orgId, "competing-left", "left-token"),
      createStagedOperation(orgId, "competing-right", "right-token"),
    ]);
    await Promise.all([
      persistStage(orgId, "left-token", operations[0]!, secrets),
      persistStage(orgId, "right-token", operations[1]!, secrets),
    ]);

    const attempts = await Promise.allSettled(
      operations.map((operation) =>
        database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.reserveVerifiedLink(client, {
            permit: operation.permit,
            staged: operation.staged,
            ...verified,
          }),
        ),
      ),
    );
    const winnerIndex = attempts.findIndex((attempt) => attempt.status === "fulfilled");
    const loserIndex = attempts.findIndex((attempt) => attempt.status === "rejected");
    expect([winnerIndex, loserIndex].sort()).toEqual([0, 1]);
    expect((attempts[loserIndex] as PromiseRejectedResult).reason).toMatchObject({
      message: "principal_reservation_in_progress",
    });
    expect((await owner.query("SELECT id FROM org_integration_connections WHERE org_id = $1", [orgId])).rowCount).toBe(
      0,
    );

    const reservation = (attempts[winnerIndex] as PromiseFulfilledResult<LinkReservation>).value;
    const winner = operations[winnerIndex]!;
    const credentialRef = await finalizeReservedSecret(secrets, reservation, winner.staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markReservationActivatePending(client, reservation, credentialRef),
    );
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.activateReservedLink(client, reservation, credentialRef),
    );
    const rows = await owner.query(
      `SELECT c.current_auth_generation, g.current_generation
       FROM org_integration_connections c JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id
       WHERE c.org_id = $1`,
      [orgId],
    );
    expect(rows.rows).toEqual([{ current_auth_generation: 1, current_generation: 1 }]);
  }, 60_000);
});
