// bh-9 real-Postgres RLS proof. The owner seeds two tenants, then every
// assertion runs through the restricted tanren_app role.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_USER = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_release_instances_rls_a";
const ORG_B = "org_release_instances_rls_b";
const PROJECT_A = "project_release_instances_rls_a";
const PROJECT_B = "project_release_instances_rls_b";
const RELEASE_A = "release_instances_rls_a";
const RELEASE_B = "release_instances_rls_b";

function databaseName(): string {
  return `tanren_release_instances_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(url: string, database: string, appRole = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_USER;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

async function seedTenant(
  owner: Pool,
  orgId: string,
  projectId: string,
  releaseId: string,
  digest: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', $2, '{"version":1}'::jsonb)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [orgId, digest],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', $4, 'production', $5, 'main', $6, NULL, $7, $8, 'live')`,
    [
      orgId,
      releaseId,
      projectId,
      `app-${releaseId}`,
      `deployment-${releaseId}`,
      digest,
      `integration-node-${releaseId}`,
      `https://example.invalid/${releaseId}`,
    ],
  );
}

describeDb("release_instances RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();

    owner = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(ADMIN_URL, database, true) });
    await seedTenant(owner, ORG_A, PROJECT_A, RELEASE_A, `sha256:${"a".repeat(64)}`);
    await seedTenant(owner, ORG_B, PROJECT_B, RELEASE_B, `sha256:${"b".repeat(64)}`);
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

  it("connects as the restricted tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: APP_USER, rolsuper: false, rolbypassrls: false });
  });

  it("shows org A only its own rows and denies cross-org and unscoped reads", async () => {
    const scoped = await runWithOrgScope(app, ORG_A, (client) =>
      client.query<{ id: string; org_id: string }>("SELECT id, org_id FROM release_instances ORDER BY id"),
    );
    expect(scoped.rows).toEqual([{ id: RELEASE_A, org_id: ORG_A }]);

    const crossOrg = await runWithOrgScope(app, ORG_A, (client) =>
      client.query("SELECT id FROM release_instances WHERE org_id = $1", [ORG_B]),
    );
    expect(crossOrg.rowCount).toBe(0);

    const unscoped = await app.query("SELECT id FROM release_instances");
    expect(unscoped.rowCount).toBe(0);
  });
});
