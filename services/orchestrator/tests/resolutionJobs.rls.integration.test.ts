// cspell:ignore iloop scontract
// Real-Postgres proof for the mutable self-healing resolution job claim/lease loop.
// The suite is deliberately skipped outside the compose-backed RLS smoke gate.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const DIGEST = `sha256:${"a".repeat(64)}`;

const ORG_A = "org_resolution_jobs_a";
const ORG_B = "org_resolution_jobs_b";
const PROJECT_A = "project_resolution_jobs_a";
const PROJECT_B = "project_resolution_jobs_b";

function databaseName(): string {
  return `tanren_resolution_jobs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, appRole = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_ROLE;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

async function seedTenant(
  owner: Pool,
  orgId: string,
  projectId: string,
): Promise<{ loopId: string; contractId: string }> {
  const sourceId = `source_${orgId}`;
  const loopId = `iloop_${orgId}`;
  const contractId = `scontract_${orgId}`;
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/resolution.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'resolution source')`,
    [sourceId, orgId, projectId],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint,
        severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'high', 'open', 'active_causal', 1, now())`,
    [orgId, loopId, projectId, sourceId, `issue-${orgId}`, `fingerprint-${orgId}`],
  );
  await owner.query(
    `INSERT INTO symptom_contracts
       (org_id, project_id, id, issue_loop_id, schema_version, contract_json,
        canonical_hash, state, baseline_required)
     VALUES ($1, $2, $3, $4, 1, '{}'::jsonb, $5, 'authored', true)`,
    [orgId, projectId, contractId, loopId, DIGEST],
  );
  return { loopId, contractId };
}

describeDb("BH-6a resolution jobs — claim lease and RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: ResolutionJobStore;
  let a: { loopId: string; contractId: string };

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(ADMIN_URL, database, true) });
    a = await seedTenant(owner, ORG_A, PROJECT_A);
    await seedTenant(owner, ORG_B, PROJECT_B);
    store = new ResolutionJobStore(app);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("leases one job once, renews it, recovers its expired lease exactly once, and denies the other org", async () => {
    await expect(
      store.enqueue({
        orgId: ORG_A,
        projectId: PROJECT_A,
        id: "rjob_a",
        issueLoopId: a.loopId,
        contractId: a.contractId,
        stage: "baseline",
        idempotencyKey: "iloop-a:baseline",
      }),
    ).resolves.toEqual({ id: "rjob_a", created: true });
    await expect(
      store.enqueue({
        orgId: ORG_A,
        projectId: PROJECT_A,
        id: "rjob_duplicate",
        issueLoopId: a.loopId,
        contractId: a.contractId,
        stage: "baseline",
        idempotencyKey: "iloop-a:baseline",
      }),
    ).resolves.toEqual({ id: "rjob_a", created: false });

    const [one, two] = await Promise.all([
      store.claimNext({ orgId: ORG_A, leaseOwner: "worker_one", leaseMs: 60_000 }),
      store.claimNext({ orgId: ORG_A, leaseOwner: "worker_two", leaseMs: 60_000 }),
    ]);
    const claimed = [one, two].filter((job) => job !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: "rjob_a", state: "running", attempt: 2 });
    expect(claimed[0]?.leaseOwner).toMatch(/^worker_(one|two)$/u);
    expect(claimed[0]?.leaseExpiry).toEqual(expect.any(String));

    const leaseOwner = claimed[0]?.leaseOwner;
    if (leaseOwner === undefined) throw new Error("expected a claimed resolution job");
    await expect(store.heartbeat({ orgId: ORG_A, id: "rjob_a", leaseOwner, leaseMs: 60_000 })).resolves.toBe(true);
    await runWithOrgScope(app, ORG_A, (client) =>
      client.query(
        "UPDATE resolution_jobs SET lease_expiry = now() - interval '1 second' WHERE org_id = $1 AND id = $2",
        [ORG_A, "rjob_a"],
      ),
    );

    const [recoveryOne, recoveryTwo] = await Promise.all([
      store.recoverExpiredLeases({ orgId: ORG_A, leaseOwner: "recovery_one", leaseMs: 60_000 }),
      store.recoverExpiredLeases({ orgId: ORG_A, leaseOwner: "recovery_two", leaseMs: 60_000 }),
    ]);
    const recovered = [...recoveryOne, ...recoveryTwo];
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: "rjob_a", state: "running", attempt: 3 });
    expect(recovered[0]?.leaseOwner).toMatch(/^recovery_(one|two)$/u);

    const foreignRows = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM resolution_jobs WHERE org_id = $1", [ORG_A]),
    );
    expect(foreignRows.rowCount).toBe(0);
    await expect(store.claimNext({ orgId: ORG_B, leaseOwner: "foreign_worker" })).resolves.toBeUndefined();
  });
});
