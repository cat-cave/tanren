// RLS wave R1 — restricted role + org session context, proven against a REAL
// Postgres. (Updated for R3b: the migration now ENABLES the policies, so the
// once-"inert" assertions that compared the raw pool to the scoped client are
// reframed as the enforcement reality — the scoped client still works, the raw
// pool is now deny-by-default.) These tests prove, end-to-end, no SQL mocks:
//   (a) the per-request org-scoped client sets `app.current_org_id` to the org;
//   (b) the worker establishes the claimed job's per-org context;
//   (c) the `runs` read+write reference path works through the org-scoped client
//       (and the raw pool is now denied by the policy);
//   (d) the RESTRICTED role can perform every operation under its own scope, is
//       provably non-bypassing, and a cross-org read on the raw pool is denied.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner). The test provisions an EPHEMERAL database on that server, migrates it
// as owner, then connects a runtime pool as the `tanren_app` role the migration
// created. Wired into `just smoke` (real Postgres up) and `just rls-r1-db-test`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { establishJobOrgContext, JobOrgContextLostError } from "../src/engine/worker/runExecutor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

// The admin/owner connection string (superuser). Defaults to the dev stack.
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
// The runtime role the migration creates, with its dev/CI default password.
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r1_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describeDb("RLS wave R1 — restricted role + org session context", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    // 1. Provision an ephemeral DB as the superuser admin and migrate it as the
    //    OWNER (migrations always run as owner — never the restricted role).
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    // 2. Connect the runtime pool AS the restricted role the migration created.
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    // Seed two orgs + a project/spec/run/task per org (as owner). The runtime
    // role reads/writes these; with no policies it sees them all.
    await seedTenant(ownerPool, ORG_A, "run_a");
    await seedTenant(ownerPool, ORG_B, "run_b");
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    // Terminate stragglers so DROP DATABASE does not block.
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // (d) The runtime role is provably restricted: non-superuser, non-bypass-RLS.
  it("(d) connects as a non-owner, non-superuser, non-bypass-RLS role", async () => {
    const { rows } = await runtimePool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]?.current_user).toBe(RUNTIME_ROLE);
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  // (a) Per-request scope sets app.current_org_id to the actor's org.
  it("(a) runWithOrgScope sets app.current_org_id for the request", async () => {
    const seen = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const { rows } = await client.query<{ org: string }>("SELECT current_setting('app.current_org_id', true) AS org");
      return rows[0]?.org;
    });
    expect(seen).toBe(ORG_A);

    // SET LOCAL is transaction-scoped: a fresh checkout has no leaked value.
    const after = await runtimePool.query<{ org: string | null }>(
      "SELECT current_setting('app.current_org_id', true) AS org",
    );
    expect(after.rows[0]?.org === "" || after.rows[0]?.org === null).toBe(true);
  });

  it("(a) rejects an unsafe org id rather than interpolating it", async () => {
    await expect(runWithOrgScope(runtimePool, "org'; DROP TABLE runs; --", async () => {})).rejects.toThrow(
      /unsafe org id/u,
    );
  });

  // (b) The worker establishes the claimed job's per-org context.
  it("(b) establishJobOrgContext sets the claimed job's org and finds its run", async () => {
    // System (cross-org) context first — mirrors the job_queue claim, which
    // spans tenants and carries NO org GUC.
    const systemOrg = await runWithSystemScope(runtimePool, async (client) => {
      const { rows } = await client.query<{ org: string | null }>(
        "SELECT current_setting('app.current_org_id', true) AS org",
      );
      return rows[0]?.org;
    });
    expect(systemOrg === "" || systemOrg === null).toBe(true);

    // Then the per-job org context: resolves the claimed run under its org.
    await expect(establishJobOrgContext(runtimePool, ORG_A, "run_a")).resolves.toBeUndefined();
    // A run that does not belong to the claimed org is not reachable under it.
    await expect(establishJobOrgContext(runtimePool, ORG_B, "run_a")).rejects.toBeInstanceOf(JobOrgContextLostError);
  });

  // (c) The runs read+write reference path works through the org-scoped client.
  //     Under R3b the policies are now ENABLED, so the scoped client sees the
  //     org's run while the RAW pool (empty GUC) sees zero — the enforcement that
  //     R3b adds. (Pre-R3b this asserted pool == scoped INERTNESS; that premise
  //     is exactly what the enforcement flip ends.)
  it("(c) runs read+write works through the org-scoped client (policies enforced)", async () => {
    // Read: the scoped client sees the org's run.
    const scoped = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const { rows } = await client.query<{ run_id: string }>(
        "SELECT run_id FROM runs WHERE run_id = $1 AND org_id = $2",
        ["run_a", ORG_A],
      );
      return rows.map((r) => r.run_id);
    });
    expect(scoped).toEqual(["run_a"]);
    // The SAME read on the raw pool (no SET LOCAL) is now denied by the policy.
    const direct = await runtimePool.query<{ run_id: string }>(
      "SELECT run_id FROM runs WHERE run_id = $1 AND org_id = $2",
      ["run_a", ORG_A],
    );
    expect(direct.rowCount).toBe(0);

    // Write: an UPDATE through the scoped client commits and is visible after
    // (confirmed via the OWNER pool, which is RLS-exempt as table owner).
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await client.query("UPDATE runs SET branch = $1 WHERE run_id = $2", ["scoped-branch", "run_a"]);
    });
    const updated = await ownerPool.query<{ branch: string }>("SELECT branch FROM runs WHERE run_id = $1", ["run_a"]);
    expect(updated.rows[0]?.branch).toBe("scoped-branch");
  });

  // (d) The restricted role can perform EVERY existing operation under its own
  //     org scope — nothing is lost. Under R3b the policies are ENABLED, so a
  //     cross-org read on the raw pool is now DENIED (the enforcement flip).
  it("(d) the restricted role can SELECT/INSERT/UPDATE/DELETE under its scope", async () => {
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      // INSERT into a bigserial table, exercising the sequence grant. Uses
      // `notifications` (a cross-org system table OUTSIDE RLS) so this proof never
      // writes `events` outside the event store (single-event-writer rule).
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO notifications (channel, payload, status) VALUES ('ntfy', '{}'::jsonb, 'queued') RETURNING id",
      );
      const id = inserted.rows[0]?.id;
      expect(id).toBeDefined();
      // SELECT it back.
      const selected = await client.query("SELECT id FROM notifications WHERE id = $1", [id]);
      expect(selected.rowCount).toBe(1);
      // UPDATE + DELETE reach.
      await client.query("UPDATE notifications SET status = 'sent' WHERE id = $1", [id]);
      const deleted = await client.query("DELETE FROM notifications WHERE id = $1", [id]);
      expect(deleted.rowCount).toBe(1);
    });

    // R3b enforcement: with policies ENABLED, the raw runtime pool (empty GUC)
    // sees ZERO of EITHER org's runs — deny-by-default. A scope is required.
    const denied = await runtimePool.query<{ org_id: string }>("SELECT DISTINCT org_id FROM runs ORDER BY org_id");
    expect(denied.rowCount).toBe(0);
    // Under a scope, the role sees ONLY its own org's run.
    const scopedDistinct = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query<{ org_id: string }>("SELECT DISTINCT org_id FROM runs"),
    );
    expect(scopedDistinct.rows.map((r) => r.org_id)).toEqual([ORG_A]);
  });

  // (d) The restricted role cannot bypass owner-only DDL.
  it("(d) the restricted role cannot create tables (DDL stays owner-only)", async () => {
    await expect(runtimePool.query("CREATE TABLE rls_should_fail (x int)")).rejects.toThrow(/permission denied/u);
  });
});

// Seed an org + project + spec + run + task for a tenant, as the owner pool.
async function seedTenant(owner: Pool, orgId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name)
     VALUES ($1, 'oidc', $1, $1, $1)`,
    [orgId],
  );
  const projectId = `proj_${orgId}`;
  const specId = `spec_${orgId}`;
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description)
     VALUES ($1, $2, $3, 't', 'd')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'queued')`,
    [runId, specId, projectId, orgId],
  );
}
