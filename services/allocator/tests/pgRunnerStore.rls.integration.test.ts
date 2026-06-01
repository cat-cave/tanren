// De-privilege the standalone allocator SERVICE. Proof, against a REAL Postgres
// with RLS ENFORCED (the migration flips the policies on), that
// the allocator service's PgRunnerStore writes the tenant `runners` row INSIDE
// the run's org scope — NOT off-RLS via the BYPASSRLS `tanren_system` role:
//
//   (a) the per-run INSERT runs through `runWithOrgScope` on the RESTRICTED
//       app-role pool, so the row carries the right org_id and is visible under
//       that org's scope, and ZERO rows under another org's scope (RLS denies);
//   (b) an INSERT under the WRONG org is rejected by the runners WITH CHECK
//       policy (the app role can never smuggle a row into another tenant);
//   (c) the cross-org SYSTEM path (markReleased / findActive, on the BYPASSRLS
//       system pool) still sees + updates the row with no org context — the
//       legitimate sweeper/release ability the shared service keeps.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the orchestrator RLS cohort tests. Wired into `just
// smoke` via `just smoke-rls-allocator`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgRunnerStore } from "../src/pgRunnerStore.js";
import type { RunnerRecord } from "../src/runnerLifecycle.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

const ORG_A = "org_alloc_a";
const ORG_B = "org_alloc_b";
const PROJECT_A = `proj_${ORG_A}`;
const SPEC_A = `spec_${ORG_A}`;
const RUN_A = "run_alloc_a";

function dbName(): string {
  return `tanren_alloc_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, database: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function recordFor(orgId: string, runnerId: string): RunnerRecord {
  return {
    runnerId,
    runId: RUN_A,
    projectId: PROJECT_A,
    orgId,
    containerId: "host-1",
    workspaceVolume: "vol-ws",
    codexHomeVolume: "vol-ch",
    sshHost: "10.0.0.1",
    sshPort: 2200,
    hostKeyFingerprint: "SHA256:abc",
    imageSha: "img@sha256:deadbeef",
    vaultRefs: [],
    createdAt: new Date(),
    released: false,
  };
}

describeDb("allocator service PgRunnerStore — runner row written under RLS, sweeper stays cross-org", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    appPool = new Pool({ connectionString: withRole(ADMIN_URL, database, APP_ROLE, APP_PASSWORD) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, database, SYSTEM_ROLE, SYSTEM_PASSWORD) });

    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    // Org B exists so the negative (zero-rows-under-other-org) assertion has a
    // second tenant scope to query under.
    await seedTenant(ownerPool, ORG_B, `proj_${ORG_B}`, `spec_${ORG_B}`, "run_alloc_b");
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("(a) insert writes the runners row under the run's org scope; visible under ORG_A, zero under ORG_B", async () => {
    const store = new PgRunnerStore(systemPool, appPool);
    await store.insert(recordFor(ORG_A, "runner_scoped"));

    // Visible — and carrying the right org_id — under ORG_A's scope.
    const underA = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ org_id: string; status: string }>(
        "SELECT org_id, status FROM runners WHERE runner_id = 'runner_scoped'",
      ),
    );
    expect(underA.rows[0]?.org_id).toBe(ORG_A);
    expect(underA.rows[0]?.status).toBe("claimed");

    // RLS denies it under ORG_B's scope — zero rows.
    const underB = await runWithOrgScope(appPool, ORG_B, (client) =>
      client.query("SELECT 1 FROM runners WHERE runner_id = 'runner_scoped'"),
    );
    expect(underB.rowCount).toBe(0);
  });

  it("(b) the app role cannot write a runners row for an org OTHER than its scope (WITH CHECK denies)", async () => {
    // Scoped to ORG_A, attempt to write a row carrying ORG_B's org_id: the
    // runners WITH CHECK policy (`org_id = current_setting('app.current_org_id')`)
    // rejects it, so the app role can never smuggle a row into another tenant.
    await expect(
      runWithOrgScope(appPool, ORG_A, (client) =>
        client.query(
          `INSERT INTO runners (
             runner_id, run_id, project_id, org_id, allocator, status, container_id, created_at
           )
           VALUES ('runner_wrong_org', $1, $2, $3, 'sidecar-docker', 'claimed', 'host-x', now())`,
          [RUN_A, PROJECT_A, ORG_B],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/iu);
    const committed = await ownerPool.query("SELECT 1 FROM runners WHERE runner_id = 'runner_wrong_org'");
    expect(committed.rowCount).toBe(0);
  });

  it("(c) the cross-org SYSTEM path (system pool, no org context) finds + releases the row", async () => {
    const store = new PgRunnerStore(systemPool, appPool);
    await store.insert(recordFor(ORG_A, "runner_sys"));

    // findActive on the BYPASSRLS system pool sees the row with NO org context —
    // the legitimate cross-org ability the shared sweeper/release path keeps.
    const found = await store.findActive("runner_sys");
    expect(found?.orgId).toBe(ORG_A);

    const released = await store.markReleased("runner_sys", "completed");
    expect(released?.orgId).toBe(ORG_A);
    const after = await ownerPool.query<{ status: string }>(
      "SELECT status FROM runners WHERE runner_id = 'runner_sys'",
    );
    expect(after.rows[0]?.status).toBe("released");
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'pending')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, orgId],
  );
}
