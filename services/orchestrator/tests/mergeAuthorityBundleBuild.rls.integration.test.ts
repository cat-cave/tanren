// Merge-authority bundle bootstrap under the restricted runtime role.
//
// `buildBundleForMergeStage` starts by resolving a run's project config + org.
// That is deliberately a cross-org bootstrap read: an unscoped `tanren_app`
// query sees zero `runs`/`projects` rows under RLS, so the read must go through
// `runWithSystemScope` and its separate BYPASSRLS `tanren_system` pool. This
// proves the real app-role call builds a bundle instead of treating its existing
// run as missing.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";

import { buildBundleForMergeStage } from "../src/engine/merge/mergeAuthorityBundleBuild.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { canonicalOrgGithubCredentialRef } from "../src/engine/credentials/refNamespace.js";
import { bindGovernanceTier, createGovernanceTier } from "../src/engine/governance/governanceTierStore.js";
import type { MergeForRunInput } from "../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";
import type { ReviewMergeRunContext } from "../src/engine/workflow/reviewMerge/context.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

const ORG_ID = "org_merge_bundle_scope";
const PROJECT_ID = "project_merge_bundle_scope";
const SPEC_ID = "spec_merge_bundle_scope";
const RUN_ID = "run_merge_bundle_scope";
const CREDENTIAL_REF = "merge-bundle";

function dbName(): string {
  return `tanren_merge_bundle_scope_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function mergeContext(): ReviewMergeRunContext {
  return {
    runId: RUN_ID,
    specId: SPEC_ID,
    projectId: PROJECT_ID,
    orgId: ORG_ID,
    prUrl: "https://github.com/example/merge-bundle-scope/pull/1",
    baseBranch: "main",
    headBranch: "merge-bundle-scope",
    staticCredentialRef: CREDENTIAL_REF,
  } as ReviewMergeRunContext;
}

describeDb("merge authority bundle bootstrap — tanren_app RLS scope", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withRole(ADMIN_URL, "tanren", "tanren", database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, "tanren_app", APP_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, "tanren_system", SYSTEM_PASSWORD, database) });
    setSystemPool(systemPool);

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'merge bundle scope', 'https://github.com/example/merge-bundle-scope.git', $2, '{"version":1}'::jsonb)`,
      [PROJECT_ID, ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'merge bundle scope', 'RLS regression coverage', 'in_flight')`,
      [SPEC_ID, PROJECT_ID, ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'merge-bundle-scope', 'running')`,
      [RUN_ID, SPEC_ID, PROJECT_ID, ORG_ID],
    );
    await runWithOrgScope(appPool, ORG_ID, async (client) => {
      const tier = await createGovernanceTier(client, {
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        tierName: "merge-bundle-scope",
        preset: "standard",
      });
      await bindGovernanceTier(client, { orgId: ORG_ID, projectId: PROJECT_ID, tierId: tier.id });
    });
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
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

  it("builds from the system-scoped bootstrap row while the caller is tanren_app with no org GUC", async () => {
    const caller = await appPool.query<{ current_user: string; org_id: string | null }>(
      "SELECT current_user, current_setting('app.current_org_id', true) AS org_id",
    );
    expect(caller.rows[0]?.current_user).toBe("tanren_app");
    // PostgreSQL represents a transaction-local setting cleared on this pooled
    // connection as either NULL or an empty string; neither supplies an org scope.
    expect(caller.rows[0]?.org_id).toBeFalsy();

    // The exact join formerly issued bare by the builder returns no rows on the
    // least-privilege runtime connection. The builder must therefore use the
    // separately configured BYPASSRLS system scope for this bootstrap query.
    const bare = await appPool.query<{ run_id: string }>(
      `SELECT r.run_id
         FROM runs r JOIN projects p ON p.project_id = r.project_id
        WHERE r.run_id = $1`,
      [RUN_ID],
    );
    expect(bare.rows).toEqual([]);

    const secrets = new InMemorySecretStore();
    await secrets.put({
      ref: canonicalOrgGithubCredentialRef({ orgId: ORG_ID, supplied: CREDENTIAL_REF, kind: "github_token" }),
      value: "test-token",
    });
    const input = {
      pool: appPool,
      runStateWriter: {},
      secrets,
      githubHttp: {
        async request() {
          // No candidate ci.yml is a valid default-config case and avoids any
          // live GitHub dependency in this RLS test.
          return { status: 404, body: {} };
        },
      },
    } as unknown as MergeForRunInput;

    const bundle = await buildBundleForMergeStage(input, mergeContext());

    expect(bundle.orgId).toBe(ORG_ID);
    expect(bundle.auditPosture).toMatchObject({ blockReviewAt: "P1" });
    expect(bundle.gateConfigHash).not.toBe("");
    const snapshots = await runWithOrgScope(appPool, ORG_ID, (client) =>
      client.query<{ effective_policy_hash: string }>(
        `SELECT effective_policy_hash
           FROM effective_policy_snapshots
          WHERE project_id = $1 AND subject_kind = 'run' AND subject_id = $2`,
        [PROJECT_ID, RUN_ID],
      ),
    );
    expect(snapshots.rows).toHaveLength(1);
    expect(bundle.policyVersion).toBe(snapshots.rows[0]?.effective_policy_hash);
  });
});
