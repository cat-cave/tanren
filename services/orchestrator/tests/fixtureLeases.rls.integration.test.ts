// PG-gated proof for rv-7 fixture leases. Run with TANREN_RLS_DB_TEST=1.

import { migrate, runWithOrgScope } from "@tanren/db";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { AllowAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import { createInternalFixtureLeaseRoutes } from "../src/routes/internal/fixtureLeases.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_fixture_lease_a";
const ORG_B = "org_fixture_lease_b";
const PROJECT_A = "project_fixture_lease_a";
const PROJECT_B = "project_fixture_lease_b";
const CLEANUP_HASH = `sha256:${"b".repeat(64)}`;

function databaseName(): string {
  return `tanren_fixture_leases_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(url: string, database: string, appRole = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_ROLE;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

async function seedTenant(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [projectId, orgId],
  );
}

function trustedRequest(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

describeDb("rv-7 fixture lease lifecycle — app-role RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let appPool: Pool;
  let app: Hono;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(owner);
    appPool = new Pool({ connectionString: connectionUrl(ADMIN_URL, database, true) });
    await seedTenant(owner, ORG_A, PROJECT_A);
    await seedTenant(owner, ORG_B, PROJECT_B);
    app = createInternalFixtureLeaseRoutes({ pool: appPool, verifier: new AllowAllPeerVerifier() });
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

  it("calls the internal lifecycle route, records events, and returns zero rows to a foreign app scope", async () => {
    const acquiredResponse = await trustedRequest(app, "/internal/fixture-leases/acquire", {
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "channel",
      correlationNamespace: "rv-7:released",
    });
    expect(acquiredResponse.status).toBe(201);
    const acquired = (await acquiredResponse.json()) as { lease: { leaseId: string; state: string } };
    expect(acquired.lease.state).toBe("leased");

    const releasedResponse = await trustedRequest(app, "/internal/fixture-leases/release", {
      orgId: ORG_A,
      projectId: PROJECT_A,
      leaseId: acquired.lease.leaseId,
      cleanupEvidenceHash: CLEANUP_HASH,
    });
    expect(releasedResponse.status).toBe(200);
    expect(await releasedResponse.json()).toMatchObject({
      lease: { leaseId: acquired.lease.leaseId, state: "released", cleanupEvidenceHash: CLEANUP_HASH },
    });

    const expiringResponse = await trustedRequest(app, "/internal/fixture-leases/acquire", {
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "dataset",
      correlationNamespace: "rv-7:expired",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const expiring = (await expiringResponse.json()) as { lease: { leaseId: string } };
    const expiryResponse = await trustedRequest(app, "/internal/fixture-leases/observe-expiry", {
      orgId: ORG_A,
      projectId: PROJECT_A,
      observedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(await expiryResponse.json()).toMatchObject({
      expired: [{ leaseId: expiring.lease.leaseId, state: "expired" }],
    });

    const foreignAcquire = await trustedRequest(app, "/internal/fixture-leases/acquire", {
      orgId: ORG_B,
      projectId: PROJECT_B,
      kind: "account",
      correlationNamespace: "rv-7:foreign",
    });
    expect(foreignAcquire.status).toBe(201);
    const foreignRows = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query("SELECT lease_id FROM fixture_leases WHERE org_id = $1 AND project_id = $2", [ORG_B, PROJECT_B]),
    );
    expect(foreignRows.rowCount).toBe(0);

    const nonOwnedRelease = await trustedRequest(app, "/internal/fixture-leases/release", {
      orgId: ORG_B,
      projectId: PROJECT_B,
      leaseId: acquired.lease.leaseId,
    });
    expect(await nonOwnedRelease.json()).toEqual({ lease: null });

    const eventRows = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ event_type: string }>(
        `SELECT event_type
           FROM events
          WHERE org_id = $1 AND project_id = $2 AND event_type LIKE 'fixture.lease.%'
          ORDER BY id`,
        [ORG_A, PROJECT_A],
      ),
    );
    expect(eventRows.rows.map((row) => row.event_type)).toEqual([
      "fixture.lease.acquired",
      "fixture.lease.released",
      "fixture.lease.acquired",
      "fixture.lease.expired",
    ]);
  });
});
