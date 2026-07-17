// Real-Postgres proof for the integration lifecycle writer. The runtime writer
// runs as non-superuser tanren_app; provider-facing data-plane code has no direct
// lifecycle query surface and must call that writer.

import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DirectIntegrationStateWriter,
  type ClaimedIntegrationReconciliation,
  type ClaimIntegrationReconciliationInput,
  type CompleteIntegrationReconciliationInput,
  type HeartbeatIntegrationReconciliationInput,
  type IntegrationStateWriter,
  type MarkIntegrationReconciliationStateUnknownInput,
} from "../src/engine/contracts/integrationStateWriter.js";
import { InMemoryIntegrationProvisioner } from "./conformance/fakes/inMemoryIntegrationProvisioner.js";
import { testOrgGrant } from "./helpers/orgGrant.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_integration_writer_a";
const ORG_B = "org_integration_writer_b";
const PROJECT_A = "project_integration_writer_a";
const PROJECT_B = "project_integration_writer_b";
const DIGEST = `sha256:${"a".repeat(64)}`;

function dbName(): string {
  return `tanren_integration_writer_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function appUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Forces the production writer's completion predicate to observe an expired lease. */
class ExpiringCompleteWriter implements IntegrationStateWriter {
  constructor(
    private readonly writer: DirectIntegrationStateWriter,
    private readonly ownerPool: Pool,
  ) {}

  claim(input: ClaimIntegrationReconciliationInput): Promise<ClaimedIntegrationReconciliation | undefined> {
    return this.writer.claim(input);
  }

  heartbeat(input: HeartbeatIntegrationReconciliationInput): Promise<boolean> {
    return this.writer.heartbeat(input);
  }

  async complete(input: CompleteIntegrationReconciliationInput): Promise<boolean> {
    await this.ownerPool.query(
      "UPDATE integration_reconciliations SET claim_expires_at = now() - interval '1 second' WHERE org_id = $1 AND id = $2",
      [input.orgId, input.reconciliationId],
    );
    return this.writer.complete(input);
  }

  stateUnknown(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    return this.writer.stateUnknown(input);
  }

  stateUnknownAfterClaimLost(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    return this.writer.stateUnknownAfterClaimLost(input);
  }
}

describeDb("IntegrationStateWriter — tenant-scoped control-plane lifecycle writes", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    await seedTenant(ownerPool, ORG_A, PROJECT_A, "requirement_a");
    await seedTenant(ownerPool, ORG_B, PROJECT_B, "requirement_b");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_A, "requirement_a", "reconciliation_data_plane");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_A, "requirement_a", "reconciliation_retry");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_A, "requirement_a", "reconciliation_fixed");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_A, "requirement_a", "reconciliation_unknown");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_A, "requirement_a", "reconciliation_lost_claim");
    await seedReconciliation(ownerPool, ORG_B, PROJECT_B, "requirement_b", "reconciliation_other_org");
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("persists claim, heartbeat, complete, retry, and state_unknown through tanren_app", async () => {
    const writer = new DirectIntegrationStateWriter(appPool);
    const provisioner = new InMemoryIntegrationProvisioner();
    const projectCtx = { orgId: ORG_A, projectId: PROJECT_A, orgSlug: "writer-a", name: "writer-a" };
    const grant = await testOrgGrant({
      orgId: ORG_A,
      projectId: PROJECT_A,
      providerKind: "sentry",
      capability: "errors",
      operation: "provision",
    });

    const dataPlane = await provisioner.reconcile({
      writer,
      reconciliationId: "reconciliation_data_plane",
      claimOwner: "data-plane-a",
      leaseMs: 30_000,
      grant,
      projectCtx,
    });
    expect(dataPlane.status).toBe("completed");
    expect(Reflect.get(provisioner, "query")).toBeUndefined();
    expect(Reflect.get(provisioner, "setIntegrationLifecycleState")).toBeUndefined();

    expect(
      await writer.claim({
        orgId: ORG_A,
        reconciliationId: "reconciliation_retry",
        claimOwner: "data-plane-a",
        leaseMs: 30_000,
      }),
    ).toMatchObject({ requirementId: "requirement_a", attempt: 1 });
    await expect(
      writer.heartbeat({
        orgId: ORG_A,
        reconciliationId: "reconciliation_retry",
        claimOwner: "data-plane-a",
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
    await expect(
      writer.complete({
        orgId: ORG_A,
        reconciliationId: "reconciliation_retry",
        claimOwner: "data-plane-a",
        status: "retry_scheduled",
        retryAfterMs: 1_000,
      }),
    ).resolves.toBe(true);

    await writer.claim({
      orgId: ORG_A,
      reconciliationId: "reconciliation_fixed",
      claimOwner: "data-plane-a",
      leaseMs: 30_000,
    });
    await expect(
      writer.complete({
        orgId: ORG_A,
        reconciliationId: "reconciliation_fixed",
        claimOwner: "data-plane-a",
        status: "fixed_point",
        failureClassification: "unchanged_provider_failure",
      }),
    ).resolves.toBe(true);

    await writer.claim({
      orgId: ORG_A,
      reconciliationId: "reconciliation_unknown",
      claimOwner: "data-plane-a",
      leaseMs: 30_000,
    });
    await expect(
      writer.stateUnknown({
        orgId: ORG_A,
        reconciliationId: "reconciliation_unknown",
        claimOwner: "data-plane-a",
        failureClassification: "provider_response_ambiguous",
      }),
    ).resolves.toBe(true);

    const rows = await ownerPool.query<{ id: string; status: string; claim_owner: string | null }>(
      `SELECT id, status, claim_owner FROM integration_reconciliations
       WHERE org_id = $1 ORDER BY id`,
      [ORG_A],
    );
    expect(rows.rows).toEqual([
      { id: "reconciliation_data_plane", status: "succeeded", claim_owner: null },
      { id: "reconciliation_fixed", status: "fixed_point", claim_owner: null },
      { id: "reconciliation_lost_claim", status: "pending", claim_owner: null },
      { id: "reconciliation_retry", status: "retry_scheduled", claim_owner: null },
      { id: "reconciliation_unknown", status: "state_unknown", claim_owner: null },
    ]);
    const events = await ownerPool.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE org_id = $1 ORDER BY id",
      [ORG_A],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "integration.reconcile.started",
      "integration.reconcile.started",
      "integration.reconcile.retry_scheduled",
      "integration.reconcile.started",
      "integration.reconcile.fixed_point",
      "integration.reconcile.started",
      "integration.reconcile.state_unknown",
    ]);
  });

  it("emits state_unknown when provider work loses its reconciliation claim", async () => {
    const writer = new ExpiringCompleteWriter(new DirectIntegrationStateWriter(appPool), ownerPool);
    const provisioner = new InMemoryIntegrationProvisioner();
    const projectCtx = { orgId: ORG_A, projectId: PROJECT_A, orgSlug: "writer-a", name: "writer-a" };
    const grant = await testOrgGrant({
      orgId: ORG_A,
      projectId: PROJECT_A,
      providerKind: "sentry",
      capability: "errors",
      operation: "provision",
    });

    await expect(
      provisioner.reconcile({
        writer,
        reconciliationId: "reconciliation_lost_claim",
        claimOwner: "data-plane-a",
        leaseMs: 30_000,
        grant,
        projectCtx,
      }),
    ).rejects.toThrow(/lost its claim/u);

    const reconciliation = await ownerPool.query<{ status: string; claim_owner: string | null }>(
      "SELECT status, claim_owner FROM integration_reconciliations WHERE org_id = $1 AND id = $2",
      [ORG_A, "reconciliation_lost_claim"],
    );
    expect(reconciliation.rows).toEqual([{ status: "state_unknown", claim_owner: null }]);
    const events = await ownerPool.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE org_id = $1 AND payload ->> 'reconciliationId' = $2 ORDER BY id",
      [ORG_A, "reconciliation_lost_claim"],
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      "integration.reconcile.started",
      "integration.reconcile.state_unknown",
    ]);
  });

  it("does not let an org-A transition address an org-B reconciliation", async () => {
    const writer = new DirectIntegrationStateWriter(appPool);
    await expect(
      writer.claim({
        orgId: ORG_A,
        reconciliationId: "reconciliation_other_org",
        claimOwner: "data-plane-a",
        leaseMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    const row = await ownerPool.query<{ status: string; claim_owner: string | null }>(
      "SELECT status, claim_owner FROM integration_reconciliations WHERE org_id = $1 AND id = $2",
      [ORG_B, "reconciliation_other_org"],
    );
    expect(row.rows).toEqual([{ status: "pending", claim_owner: null }]);
  });
});

async function seedTenant(pool: Pool, orgId: string, projectId: string, requirementId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/writer.git', $2)`,
    [projectId, orgId],
  );
  await pool.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state,
        source_kind, source_revision_id, source_digest, policy_version, criticality)
     VALUES ($1, $2, $3, 'errors', 'product', 'outbound', '{}'::jsonb,
             'design_contract', $2, $4, 'policy-v1', 'release_required')`,
    [orgId, requirementId, projectId, DIGEST],
  );
}

async function seedReconciliation(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  reconciliationId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_reconciliations
       (org_id, id, project_id, requirement_id, phase, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 'provision', $2, $5)`,
    [orgId, reconciliationId, projectId, requirementId, DIGEST],
  );
}
