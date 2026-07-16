import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrincipalCandidate } from "../src/engine/contracts/integrationAuthority.js";
import type { PutCreateOnlyResult, SecretValue } from "../src/engine/contracts/secretStore.js";
import { InMemorySecretStore, SecretStoreWriteError } from "../src/engine/contracts/secretStore.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import { integrationRequestFingerprint } from "../src/engine/integrations/integrationOperationFingerprint.js";
import { IntegrationSecretCleanupReaper } from "../src/engine/integrations/integrationSecretCleanupReaper.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import type { LinkReservation } from "../src/engine/repositories/integrationConnectionFinalize.js";
import { IntegrationConnectionsStore } from "../src/engine/repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import { mutateProjectConfig } from "../src/engine/repositories/projects.js";
import type { IntegrationAuthorityRouteDatabase } from "../src/routes/integrations/authorityWrites.js";
import { runDurableLinkSaga } from "../src/routes/integrations/linkSaga.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const PRINCIPAL: PrincipalCandidate = {
  providerPrincipalId: "durable-team",
  principalKind: "team",
  displayName: "Durable Team",
  metadata: { slug: "durable-team" },
};
const VERIFIED = { principal: PRINCIPAL, authKind: "api_key", scopes: [] as string[] };

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

class FailingCleanupStore extends InMemorySecretStore {
  finalizeMode: "ok" | "definite" = "ok";
  cleanupAvailable = false;
  beforeDelete?: (ref: string) => Promise<void>;

  override async putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult> {
    if (this.finalizeMode === "definite") {
      throw new SecretStoreWriteError("injected definite write failure", "definitely_unwritten");
    }
    return super.putCreateOnly(secret);
  }

  override async delete(ref: string): Promise<void> {
    await this.beforeDelete?.(ref);
    if (!this.cleanupAvailable) throw new Error("injected staged cleanup failure");
    await super.delete(ref);
  }
}

async function waitForBlockedTransition(pool: Pool, databaseName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: number }>(
      `SELECT count(*)::int AS blocked
       FROM pg_stat_activity
       WHERE datname = $1 AND wait_event_type = 'Lock'
         AND query LIKE '%UPDATE org_integration_connection_operations%'`,
      [databaseName],
    );
    if ((result.rows[0]?.blocked ?? 0) > 0) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("stale operation transition never blocked on the reservation lock");
}

describeDb("IN-1 operation durability — real PostgreSQL", () => {
  const dbName = `tanren_in_operation_durability_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const authority = new PgIntegrationAuthority();
  let owner: Pool;
  let database: SagaDatabase;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, dbName) });
    await migrate(owner);
    setSystemPool(owner);
    database = new SagaDatabase(owner);
  }, 120_000);

  afterAll(async () => {
    resetSystemPool();
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
    secrets: GenerationAddressedIntegrationSecretStore,
  ) {
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
    const staged = { handle: permit.stagedSecretHandle, operationId: permit.operationId };
    await secrets.stage(permit.operationId, token);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markOperationStaged(client, orgId, permit.operationId, staged.handle),
    );
    return { permit, staged };
  }

  it("pre-reservation stale verifier transitions lose exact-state CAS after a real row-lock race", async () => {
    const orgId = "org_transition_race";
    await seedOrg(orgId);
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const operation = await createStagedOperation(orgId, "race", "race-token", secrets);
    const winner = await owner.connect();
    let committed = false;
    let awaiting: Promise<boolean> | undefined;
    let failing: Promise<boolean> | undefined;
    try {
      await winner.query("BEGIN");
      await winner.query(`SET LOCAL app.current_org_id = '${orgId}'`);
      const reservation = (await IntegrationConnectionsStore.reserveVerifiedLink(winner, {
        ...operation,
        ...VERIFIED,
      })) as LinkReservation;

      awaiting = database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.markAwaitingPrincipalSelection(client, orgId, operation.permit.operationId, [
          PRINCIPAL,
        ]),
      );
      failing = database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.markOperationFailed(
          client,
          orgId,
          operation.permit.operationId,
          "stale_invalid_verification",
        ),
      );
      await waitForBlockedTransition(owner, dbName);
      await winner.query("COMMIT");
      committed = true;

      expect(await awaiting).toBe(false);
      expect(await failing).toBe(false);
      const row = await owner.query(
        `SELECT stage, status, verification_fingerprint, reserved_connection_id, failure_classification
         FROM org_integration_connection_operations WHERE org_id = $1 AND id = $2`,
        [orgId, operation.permit.operationId],
      );
      expect(row.rows[0]).toMatchObject({
        stage: "finalizing",
        status: "in_progress",
        reserved_connection_id: reservation.connectionId,
        failure_classification: null,
      });
      expect(row.rows[0]?.verification_fingerprint).not.toBeNull();
    } finally {
      if (!committed) await winner.query("ROLLBACK").catch(() => {});
      winner.release();
      if (!committed) await Promise.allSettled([awaiting, failing].filter((item) => item !== undefined));
    }
  }, 60_000);

  it("a delayed non-terminal diagnostic cannot rewrite a concurrently terminal receipt", async () => {
    const orgId = "org_retry_diagnostic_race";
    await seedOrg(orgId);
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const operation = await createStagedOperation(orgId, "diagnostic-race", "diagnostic-token", secrets);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.reserveVerifiedLink(client, {
        ...operation,
        ...VERIFIED,
      }),
    );
    const winner = await owner.connect();
    let committed = false;
    let diagnostic: Promise<boolean> | undefined;
    try {
      await winner.query("BEGIN");
      await winner.query(`SET LOCAL app.current_org_id = '${orgId}'`);
      await winner.query(
        `SELECT id FROM org_integration_connection_operations
         WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, operation.permit.operationId],
      );

      diagnostic = database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.recordNonterminalFailure(
          client,
          orgId,
          operation.permit.operationId,
          "stale_retry_diagnostic",
        ),
      );
      await waitForBlockedTransition(owner, dbName);
      await winner.query(
        `UPDATE org_integration_connection_operations
         SET stage = 'completed', status = 'completed',
             failure_classification = 'winner_terminal_receipt',
             staged_secret_handle = NULL,
             compensation_state = compensation_state || '{"stagedCleanup":"completed"}'::jsonb,
             updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [orgId, operation.permit.operationId],
      );
      await winner.query("COMMIT");
      committed = true;

      expect(await diagnostic).toBe(false);
      const row = await owner.query(
        `SELECT stage, status, failure_classification
         FROM org_integration_connection_operations WHERE org_id = $1 AND id = $2`,
        [orgId, operation.permit.operationId],
      );
      expect(row.rows[0]).toEqual({
        stage: "completed",
        status: "completed",
        failure_classification: "winner_terminal_receipt",
      });
    } finally {
      if (!committed) await winner.query("ROLLBACK").catch(() => {});
      winner.release();
      if (!committed && diagnostic !== undefined) await Promise.allSettled([diagnostic]);
    }
  }, 60_000);

  it("records terminal failure before cleanup and reaps retained staged bytes after recovery", async () => {
    const orgId = "org_cleanup_reaper";
    await seedOrg(orgId);
    const base = new FailingCleanupStore();
    base.finalizeMode = "definite";
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const operation = await createStagedOperation(orgId, "cleanup", "cleanup-token", secrets);
    base.beforeDelete = async (ref) => {
      expect(ref).toBe(operation.staged.handle);
      const receipt = await owner.query(
        `SELECT stage, status, compensation_state
         FROM org_integration_connection_operations WHERE org_id = $1 AND id = $2`,
        [orgId, operation.permit.operationId],
      );
      expect(receipt.rows[0]).toMatchObject({
        stage: "failed",
        status: "failed",
        compensation_state: { stagedCleanup: "pending" },
      });
    };

    const outcome = await runDurableLinkSaga(database, orgId, secrets, {
      ...operation,
      credential: "cleanup-token",
      verified: VERIFIED,
    });
    expect(outcome).toEqual({ status: "failed", reason: "secret_finalize_failed" });
    expect(await base.get(operation.staged.handle)).toMatchObject({ value: "cleanup-token" });

    base.beforeDelete = undefined;
    base.cleanupAvailable = true;
    const reaper = new IntegrationSecretCleanupReaper({ pool: owner, secrets: base });
    expect(await reaper.tick()).toBe(1);
    expect(await reaper.tick()).toBe(0);
    expect(await base.get(operation.staged.handle)).toBeUndefined();
    const converged = await owner.query(
      `SELECT stage, status, staged_secret_handle, compensation_state
       FROM org_integration_connection_operations WHERE org_id = $1 AND id = $2`,
      [orgId, operation.permit.operationId],
    );
    expect(converged.rows[0]).toMatchObject({
      stage: "failed",
      status: "failed",
      staged_secret_handle: null,
      compensation_state: { stagedCleanup: "completed" },
    });
  }, 60_000);

  it("forces concurrent project-config writers through CAS and preserves both mutations", async () => {
    const orgId = "org_config_cas";
    const projectId = "project_config_cas";
    await seedOrg(orgId);
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'config cas', 'https://example.com/config-cas.git', $2, '{"version":1}'::jsonb)`,
      [projectId, orgId],
    );

    let initialReads = 0;
    let releaseInitialReads: (() => void) | undefined;
    const bothRead = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const racingClient: IntegrationQueryClient = {
      async query(sql, params) {
        const result = await owner.query(sql, params);
        if (sql.startsWith("SELECT config FROM projects") && initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads?.();
          await bothRead;
        }
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };

    await Promise.all([
      mutateProjectConfig(racingClient, projectId, { kind: "system" }, (raw) => ({
        ...(raw as Record<string, unknown>),
        governancePosture: "warn",
      })),
      mutateProjectConfig(racingClient, projectId, { kind: "system" }, (raw) => ({
        ...(raw as Record<string, unknown>),
        budget: { ceilingUsd: 25, period: "monthly" },
      })),
    ]);

    expect(initialReads).toBe(2);
    const stored = await owner.query("SELECT config FROM projects WHERE project_id = $1", [projectId]);
    expect(stored.rows[0]?.config).toEqual({
      version: 1,
      governancePosture: "warn",
      budget: { ceilingUsd: 25, period: "monthly" },
    });
  });
});
