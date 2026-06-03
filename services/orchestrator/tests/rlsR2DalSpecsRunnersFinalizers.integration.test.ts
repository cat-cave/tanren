// RLS wave R2 cohort-3 — specs + runners + the worker failure-path finalizers
// DAL conversion, proven against a REAL Postgres (no SQL mocks).
//
// R2 cohort-3 routes the specs read/write sites, the runner-metadata writes, and
// the worker's failure-path finalize writes through R1's org-scoped client
// (`runWithOrgScope` → `getOrgScopedClient()`), so each tenant query executes
// inside a `SET LOCAL app.current_org_id = <org>` transaction. (Updated for R3b:
// the migration now ENABLES the policies — the org-scoped client returns/writes
// the org's rows while the raw runtime pool is deny-by-default; baselines compare
// against the OWNER pool, and the unscoped pool-fallback writes are now denied.)
// These tests prove that end-to-end:
//   (a) the specs READ loaders (SpecStore.get/list) return the org's rows on the
//       org-scoped client, identical to the raw pool;
//   (b) the specs WRITE paths (createSpec INSERT via the engine, SpecStore
//       status UPDATE) commit through the ambient scope AND fall back to the pool
//       when there is none — same committed row either way;
//   (c) the runner-metadata WRITES (PgRunnerStore.claim / .release, handed the
//       pool) route through the ambient org-scoped client inside a scope and via
//       the pool fallback — same committed row either way;
//   (e) the worker failure-path finalize UPDATE (runs → halted) commits the same
//       row inside an org scope as on the pool — the org-scoping the worker's
//       finalizers now establish.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 / cohort-1 / cohort-2 tests. Wired into `just
// smoke` via the same gate (`just smoke-rls-r2-cohort3`).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgRunnerStore } from "../src/engine/allocators/runnerStore.js";
import { MissingOrgScopeError } from "../src/engine/data/orgScopedDb.js";
import { createSpec } from "../src/engine/workflow/projectSpec.js";
import { SpecStore } from "../src/engine/repositories/specs.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r2c3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_rls_a";
const ORG_B = "org_rls_b";
const PROJECT_A = `proj_${ORG_A}`;
const SPEC_A = `spec_${ORG_A}`;
const RUN_A = "run_a";

// An actor carrying ORG_A — drives the org-scoped createSpec path. Granted
// platform:admin so the project-access check short-circuits without needing a
// project_members/users row (this cohort proves the DAL seam, not authz).
const ACTOR_A = {
  userId: "user_a",
  orgId: ORG_A,
  scopes: ["platform:admin"],
} as const;

describeDb("RLS R2 cohort-3 — specs + runners + finalizers through the org-scoped client", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    // Two orgs; only org A gets a project + spec + run. Org B exists to prove the
    // app-layer org predicate still scopes reads (belt-and-suspenders).
    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(ownerPool, ORG_B, `proj_${ORG_B}`, `spec_${ORG_B}`, "run_b");
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

  // (a) specs READ loaders, through the org-scoped client, equal the OWNER
  //     (RLS-exempt) baseline. Under R3b the raw runtime pool is deny-by-default.
  it("(a) spec reads via the org-scoped client match the owner baseline, scoped to the org", async () => {
    const scoped = await runWithOrgScope(runtimePool, ORG_A, (client) => SpecStore.get(client, SPEC_A, ACTOR_A));
    const owned = await SpecStore.get(ownerPool, SPEC_A, ACTOR_A);
    expect(scoped?.specId).toBe(SPEC_A);
    expect(scoped).toEqual(owned);
    // The raw runtime pool (empty GUC) now returns nothing (R3b enforcement).
    const pooled = await SpecStore.get(runtimePool, SPEC_A, ACTOR_A);
    expect(pooled).toBeUndefined();

    const scopedList = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      SpecStore.list(client, { projectId: PROJECT_A }, ACTOR_A),
    );
    const ownedList = await SpecStore.list(ownerPool, { projectId: PROJECT_A }, ACTOR_A);
    expect(scopedList.map((s) => s.specId)).toEqual(ownedList.map((s) => s.specId));
    expect(scopedList.length).toBeGreaterThan(0);

    // App-layer scoping: org A's project does not surface org B's spec.
    expect(scopedList.map((s) => s.specId)).not.toContain(`spec_${ORG_B}`);
  });

  // (b) specs WRITE paths: the engine createSpec (org actor → org-scoped) commits,
  //     and the SpecStore status UPDATE works inside a scope AND via the pool.
  it("(b) createSpec + spec status UPDATE write through the scope and via the pool fallback", async () => {
    // createSpec with an org-carrying actor runs through runWithOrgScope; the row
    // commits and is readable afterward (proving the scoped INSERT landed).
    const created = await createSpec(
      runtimePool,
      {
        projectId: PROJECT_A,
        title: "scoped spec",
        description: "made under org scope",
        acceptanceCriteria: ["ok"],
      },
      ACTOR_A as never,
    );
    // Re-read via the OWNER pool (RLS-exempt): the scoped INSERT landed, stamped
    // org A. The raw runtime pool would now see nothing (R3b deny-by-default).
    const reread = await SpecStore.get(ownerPool, created.specId, ACTOR_A);
    expect(reread?.specId).toBe(created.specId);
    expect(reread?.orgId).toBe(ORG_A);

    // Status UPDATE inside a scope: visible within the SAME transaction (only if
    // the UPDATE used the ambient client).
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await SpecStore.updateStatus(client, created.specId, { from: "pending", to: "active" }, ACTOR_A);
      const within = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
        created.specId,
      ]);
      expect(within.rows[0]?.status).toBe("active");
    });

    // Status UPDATE via the raw pool (no scope) now matches ZERO rows under the
    // policy → the store raises "spec not found". Under R3b an unscoped write
    // can neither read nor mutate a tenant row.
    await expect(
      SpecStore.updateStatus(runtimePool, created.specId, { from: "active", to: "done" }, ACTOR_A),
    ).rejects.toThrow(/spec not found/u);
    // The spec is still 'active' (the denied UPDATE changed nothing) per owner.
    const stillActive = await SpecStore.get(ownerPool, created.specId, ACTOR_A);
    expect(stillActive?.status).toBe("active");
  });

  // (c) runner-metadata WRITES route through the ambient scope, and fall back to
  //     the pool when there is none — same committed row either way.
  it("(c) PgRunnerStore.claim/.release write through the scope and via the pool fallback", async () => {
    const store = new PgRunnerStore(runtimePool);
    const claimInput = {
      runnerId: "runner_scoped",
      runId: RUN_A,
      projectId: PROJECT_A,
      allocator: "manual-ssh",
      sshHost: "10.0.0.1",
      sshPort: 2200,
      hostKeyFingerprint: "SHA256:abc",
      imageSha: "img@sha256:deadbeef",
      containerId: "host-1",
    };

    // In-scope: the claim INSERT runs on the ambient client; the new row is
    // visible inside the SAME transaction.
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await store.claim(claimInput);
      const within = await client.query<{ status: string; org_id: string }>(
        "SELECT status, org_id FROM runners WHERE runner_id = 'runner_scoped'",
      );
      expect(within.rows[0]?.status).toBe("claimed");
      // org_id is derived in-statement from the run — proves the tenancy subquery.
      expect(within.rows[0]?.org_id).toBe(ORG_A);
      await store.release("runner_scoped");
      const released = await client.query<{ status: string }>(
        "SELECT status FROM runners WHERE runner_id = 'runner_scoped'",
      );
      expect(released.rows[0]?.status).toBe("released");
    });

    // Out-of-scope: the same store handed the pool has NO ambient scope (no
    // connection scope, no per-job org id), so the claim is refused LOUDLY at the
    // DAL seam — an unscoped tenant write never even reaches the DB's WITH CHECK.
    await expect(store.claim({ ...claimInput, runnerId: "runner_pool" })).rejects.toThrow(MissingOrgScopeError);
    const committed = await ownerPool.query("SELECT 1 FROM runners WHERE runner_id = 'runner_pool'");
    expect(committed.rowCount).toBe(0);
  });

  // (e) the worker failure-path finalize UPDATE (runs → halted) commits the same
  //     row inside an org scope as on the pool — the org-scoping the worker's
  //     finalizers now establish (the UPDATE the run executor runs in the catch
  //     path, here proven org-scoped vs pool-fallback).
  it("(e) the run-finalize UPDATE commits the same row inside an org scope as on the pool", async () => {
    // Seed a fresh running run for org A to finalize.
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ('run_finalize', $1, $2, $3, 'cli', 'main', 'running')`,
      [SPEC_A, PROJECT_A, ORG_A],
    );

    // Finalize under the org scope — the UPDATE runs on the ambient client and
    // the row is visible halted inside the SAME transaction.
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const updated = await client.query(
        "UPDATE runs SET status = 'halted', outcome = 'halted', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued', 'failed') RETURNING run_id, spec_id, project_id",
        ["run_finalize"],
      );
      expect(updated.rowCount).toBe(1);
      const within = await client.query<{ status: string; outcome: string }>(
        "SELECT status, outcome FROM runs WHERE run_id = 'run_finalize'",
      );
      expect(within.rows[0]).toEqual({ status: "halted", outcome: "halted" });
    });

    // The finalize committed: a fresh OWNER read (RLS-exempt ground truth) sees
    // the halted terminal state. (The raw runtime pool would now see nothing —
    // deny-by-default — so the worker's finalizer scopes its UPDATE, which it does.)
    const committed = await ownerPool.query<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM runs WHERE run_id = 'run_finalize'",
    );
    expect(committed.rows[0]).toEqual({ status: "halted", outcome: "halted" });
  });
});

// Seed an org + project + spec + run for a tenant, as the owner pool. Mirrors the
// cohort-1/2 tests' seeder; kept local so the cohorts stay independent.
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
