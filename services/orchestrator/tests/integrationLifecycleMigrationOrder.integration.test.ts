// cspell:ignore conrelid confrelid contype relnamespace nspname
import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Executable empty-PostgreSQL proof that migration chain 0000→0041 applies
 * cleanly (no DDL ordering / 42830 errors) and that the composite org-qualified
 * FKs + unique keys exist and reject wrong-org / cross-binding rows.
 *
 * Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL — same
 * harness as integrationLifecycleRls.integration.test.ts.
 */
const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

const ORG_A = "org_in_mig_order_a";
const ORG_B = "org_in_mig_order_b";
const PROJECT_A = "project_in_mig_order_a";
const PROJECT_B = "project_in_mig_order_b";
const DIGEST = `sha256:${"b".repeat(64)}`;

/** Composite unique indexes that must exist before dependent FKs in 0041. */
const REQUIRED_UNIQUE_INDEXES = [
  "projects_org_project_unique",
  "specs_org_spec_unique",
  "org_integration_connections_provider_id_unique",
  "org_integration_grants_connection_id_unique",
] as const;

/** Representative composite FKs that previously failed on empty apply (42830). */
const REQUIRED_COMPOSITE_FKS = [
  "capability_nodes_project_fk",
  "spec_capability_dependencies_spec_fk",
  "integration_validation_proofs_spec_fk",
  "project_integration_grant_selections_connection_fk",
  "project_integration_grant_selections_grant_fk",
  "project_app_env_project_fk",
] as const;

function dbName(): string {
  return `tanren_in_mig_order_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("IN-1 migration order — empty PostgreSQL chain 0000→0041", () => {
  const database = dbName();
  let ownerPool: Pool;
  let migrateError: unknown;
  let connectionA = "";
  let connectionB = "";
  let grantA = "";

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    try {
      await migrate(ownerPool);
    } catch (error) {
      migrateError = error;
      return;
    }

    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);

    const connA = await ownerPool.query<{ id: string }>(
      `INSERT INTO org_integration_connections
         (org_id, id, provider_kind, upstream_account_id, auth_kind, credential_ref, owner_id)
       VALUES ($1, 'conn-a', 'sentry', 'account-a', 'api_key', 'secret://a', 'owner-a')
       RETURNING id`,
      [ORG_A],
    );
    connectionA = connA.rows[0]!.id;

    const connB = await ownerPool.query<{ id: string }>(
      `INSERT INTO org_integration_connections
         (org_id, id, provider_kind, upstream_account_id, auth_kind, credential_ref, owner_id)
       VALUES ($1, 'conn-b', 'sentry', 'account-b', 'api_key', 'secret://b', 'owner-b')
       RETURNING id`,
      [ORG_B],
    );
    connectionB = connB.rows[0]!.id;

    const gA = await ownerPool.query<{ id: string }>(
      `INSERT INTO org_integration_grants
         (org_id, id, connection_id, plane, environment, policy_revision, consent_revision, status)
       VALUES ($1, 'grant-a', $2, 'control', 'control', 'p1', 'c1', 'active')
       RETURNING id`,
      [ORG_A, connectionA],
    );
    grantA = gA.rows[0]!.id;

    await ownerPool.query(
      `INSERT INTO org_integration_grants
         (org_id, id, connection_id, plane, environment, policy_revision, consent_revision, status)
       VALUES ($1, 'grant-b', $2, 'control', 'control', 'p1', 'c1', 'active')`,
      [ORG_B, connectionB],
    );
  }, 120_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("applies the complete migration chain to a genuinely empty database", () => {
    if (migrateError !== undefined) {
      throw migrateError;
    }
    expect(migrateError).toBeUndefined();
  });

  it("materializes the composite unique keys and dependent foreign keys", async () => {
    expect(migrateError).toBeUndefined();

    const indexes = await ownerPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[...REQUIRED_UNIQUE_INDEXES]],
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([...REQUIRED_UNIQUE_INDEXES].sort());

    const fks = await ownerPool.query<{ conname: string }>(
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
         AND c.contype = 'f'
         AND c.conname = ANY($1::text[])
       ORDER BY c.conname`,
      [[...REQUIRED_COMPOSITE_FKS]],
    );
    expect(fks.rows.map((row) => row.conname).sort()).toEqual([...REQUIRED_COMPOSITE_FKS].sort());
  });

  it("rejects wrong-org project and cross-binding selection rows via composite FKs", async () => {
    expect(migrateError).toBeUndefined();

    // integration_requirements_project_fk: org_id A + project_id belonging to org B.
    await expect(
      ownerPool.query(
        `INSERT INTO integration_requirements
           (org_id, id, project_id, capability, plane, direction, desired_state,
            source_kind, source_revision_id, source_digest, policy_version, criticality)
         VALUES ($1, 'req-cross-project', $2, 'errors', 'product', 'outbound', '{}'::jsonb,
                 'design_contract', 'design-x', $3, 'policy-v1', 'release_required')`,
        [ORG_A, PROJECT_B, DIGEST],
      ),
    ).rejects.toThrow(/foreign key|violates/iu);

    // project_integration_grant_selections_connection_fk: org A selecting org B's connection.
    await expect(
      ownerPool.query(
        `INSERT INTO project_integration_grant_selections
           (org_id, project_id, provider_kind, connection_id, grant_id, selected_by)
         VALUES ($1, $2, 'sentry', $3, $4, 'tester')`,
        [ORG_A, PROJECT_A, connectionB, grantA],
      ),
    ).rejects.toThrow(/foreign key|violates/iu);

    // project_integration_grant_selections_grant_fk: connection A + grant that is not on that connection.
    await expect(
      ownerPool.query(
        `INSERT INTO project_integration_grant_selections
           (org_id, project_id, provider_kind, connection_id, grant_id, selected_by)
         VALUES ($1, $2, 'sentry', $3, 'grant-b', 'tester')`,
        [ORG_A, PROJECT_A, connectionA],
      ),
    ).rejects.toThrow(/foreign key|violates/iu);

    // Happy path: same-org composite binding is accepted.
    await ownerPool.query(
      `INSERT INTO project_integration_grant_selections
         (org_id, project_id, provider_kind, connection_id, grant_id, selected_by)
       VALUES ($1, $2, 'sentry', $3, $4, 'tester')`,
      [ORG_A, PROJECT_A, connectionA, grantA],
    );
    const accepted = await ownerPool.query(
      `SELECT connection_id, grant_id FROM project_integration_grant_selections
       WHERE org_id = $1 AND project_id = $2 AND provider_kind = 'sentry'`,
      [ORG_A, PROJECT_A],
    );
    expect(accepted.rows).toEqual([{ connection_id: connectionA, grant_id: grantA }]);
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [projectId, orgId],
  );
}
