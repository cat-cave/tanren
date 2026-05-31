// RLS org-creation bootstrap — the regression proof, against a REAL Postgres.
//
// Live validation found that org creation is BROKEN under enforced RLS: signup /
// dev-login / onboarding all call `IdentityStore.upsertIdentity` (→ `upsertOrg` +
// `ensureOrgMembership`) on the runtime `tanren_app` role (NOBYPASSRLS) with NO
// `app.current_org_id` set — because creating an org is a tenant BOOTSTRAP that
// precedes any org scope. Migration 0030's deny-by-default policy on
// `organizations` / `org_members` (`WITH CHECK (... = current_setting(
// 'app.current_org_id', true))`) therefore rejects the INSERT with SQLSTATE 42501.
//
// The earlier R-wave tests missed it because they seed orgs AS THE OWNER (RLS-
// exempt) or use the system bypass directly — none drives the real `tanren_app`
// signup path. This test does, against a REAL migrated DB under `tanren_app`:
//
//   (a) REPRODUCE: with NO system pool configured, `upsertIdentity` creating a
//       NEW org on the plain `tanren_app` runtime pool is rejected with 42501.
//   (b) FIX: with the BYPASSRLS `tanren_system` pool configured (as wiring does
//       via TANREN_SYSTEM_DATABASE_URL → getSystemPool), the SAME signup succeeds
//       — `upsertOrg` / `ensureOrgMembership` route through `runWithSystemScope`.
//   (c) READS stay under RLS: the newly-created org is visible ONLY inside its own
//       org scope on `tanren_app`, and NOT under a different org's scope nor on
//       the bare (unset-GUC) pool. No policy was loosened.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the R1 / R2 / R3a / R3b cohort tests. Wired into
// `just smoke` via `just smoke-rls-org-bootstrap`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { IdentityStore } from "../src/auth/identityStore.js";
import type { IdentityClaims } from "../src/auth/schemas.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_rls_org_bootstrap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
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

// A signup identity carrying exactly one org claim — the bootstrap org the
// signup must mint. Mirrors what github_oauth / oidc / local_dev resolve.
function signupIdentity(suffix: string): IdentityClaims {
  return {
    providerSubject: `subject-${suffix}`,
    login: `user-${suffix}`,
    email: `${suffix}@example.com`,
    displayName: `User ${suffix}`,
    orgs: [
      {
        externalId: `ext-${suffix}`,
        login: `org-${suffix}`,
        displayName: `Org ${suffix}`,
        kind: "github_org",
      },
    ],
  };
}

describeDb("RLS org-creation bootstrap — signup mints an org under the tanren_app role", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration enables RLS + the deny-by-default policies AND creates
    // the tanren_app / tanren_system roles.
    await migrate(ownerPool);

    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
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

  // (a) THE BUG: with no system pool configured, the IdentityStore runs entirely
  //     on the `tanren_app` runtime pool. Signup must mint a NEW org before any
  //     org scope exists, so the empty-GUC INSERT is rejected by the policy.
  it("(a) reproduces the failure: org-creating signup on the bare app pool is rejected with 42501", async () => {
    // No bypass pool → runWithSystemScope falls back to appPool (the bug surface).
    setSystemPool(undefined);
    const store = new IdentityStore(appPool);
    await expect(store.upsertIdentity("github_oauth", signupIdentity("repro"))).rejects.toMatchObject({
      code: "42501",
    });
    // Nothing landed (owner pool = RLS-exempt ground truth).
    const orphan = await ownerPool.query("SELECT 1 FROM organizations WHERE external_id = 'ext-repro'");
    expect(orphan.rowCount).toBe(0);
  });

  // (b) THE FIX: with the BYPASSRLS tanren_system pool configured (exactly as
  //     production wiring resolves it from TANREN_SYSTEM_DATABASE_URL via
  //     getSystemPool), the SAME signup succeeds — upsertOrg + ensureOrgMembership
  //     route through runWithSystemScope, which uses the system pool.
  it("(b) succeeds via the system bypass scope: signup mints the org + admin membership", async () => {
    setSystemPool(systemPool);
    try {
      const store = new IdentityStore(appPool);
      const result = await store.upsertIdentity("github_oauth", signupIdentity("fix"));
      expect(result.orgs).toHaveLength(1);
      const orgId = result.orgs[0]!.id;
      expect(result.primaryOrgId).toBe(orgId);

      // The org + the first member (admin) landed (owner pool = ground truth).
      const org = await ownerPool.query("SELECT id FROM organizations WHERE external_id = 'ext-fix'");
      expect(org.rows[0]).toMatchObject({ id: orgId });
      const member = await ownerPool.query<{ role: string }>(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, result.user.id],
      );
      expect(member.rows[0]?.role).toBe("admin");

      // (c) READS stay under RLS: the new org is visible ONLY in its own org
      //     scope on the tanren_app role, and NOT on the bare unset-GUC pool nor
      //     a different org's scope. The bootstrap-creation write bypassed; reads
      //     did not.
      await runWithOrgScope(appPool, orgId, async (client) => {
        const seen = await client.query("SELECT id FROM organizations WHERE id = $1", [orgId]);
        expect(seen.rowCount).toBe(1);
      });
      const bare = await appPool.query("SELECT id FROM organizations WHERE id = $1", [orgId]);
      expect(bare.rowCount, "unset-GUC pool must not see the org (deny-by-default still holds)").toBe(0);
      await runWithOrgScope(appPool, "org_other_tenant", async (client) => {
        const cross = await client.query("SELECT id FROM organizations WHERE id = $1", [orgId]);
        expect(cross.rowCount, "a different org's scope must not see the new org").toBe(0);
      });
    } finally {
      setSystemPool(undefined);
    }
  });
});
