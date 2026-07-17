// PostgreSQL proof for gv-11's immutable repository-visibility attestations.
// Run with TANREN_RLS_DB_TEST=1; the ordinary test gate skips this suite.

import { migrate, runWithOrgScope } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  RepositoryVisibilityAdmissionBlockedError,
  RepositoryVisibilityRunAdmission,
} from "../src/engine/governance/repositoryVisibilityAdmission.js";
import { RepositoryVisibilityObservationsStore } from "../src/engine/repositories/repositoryVisibilityObservations.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_repository_visibility_a";
const ORG_B = "org_repository_visibility_b";
const PROJECT_A = "project_repository_visibility_a";
const PROJECT_B = "project_repository_visibility_b";

function databaseName(): string {
  return `tanren_repository_visibility_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedProject(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, repo_visibility, config)
     VALUES ($1, $1, 'https://github.com/example/private-repo.git', 'main', 'runner:test', $2, 'private', '{"version":1}'::jsonb)`,
    [projectId, orgId],
  );
}

describeDb("repository visibility observations — immutable and tenant-isolated", () => {
  const database = databaseName();
  let ownerPool: Pool | undefined;
  let appPool: Pool | undefined;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database, true) });
    await seedProject(ownerPool, ORG_A, PROJECT_A);
    await seedProject(ownerPool, ORG_B, PROJECT_B);
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

  it("automatically admits a matching run and blocks a visibility mismatch as tanren_app", async () => {
    const pool = requiredPool(appPool);
    expect((await pool.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user).toBe(APP_ROLE);
    let observedVisibility: "public" | "private" = "private";
    const admission = new RepositoryVisibilityRunAdmission(pool, {
      readRepositoryVisibility: async () => ({
        observedVisibility,
        forgeRef: "github:example/private-repo",
        sha: observedVisibility === "private" ? "match-sha" : "mismatch-sha",
      }),
    });

    await expect(admission.admit({ orgId: ORG_A, projectId: PROJECT_A })).resolves.toBeUndefined();
    observedVisibility = "public";
    await expect(admission.admit({ orgId: ORG_A, projectId: PROJECT_A })).rejects.toBeInstanceOf(
      RepositoryVisibilityAdmissionBlockedError,
    );

    const events = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query<{ event_type: string }>(
        `SELECT event_type
           FROM events
          WHERE org_id = $1 AND project_id = $2
            AND event_type IN (
              'repository.visibility.observed',
              'repository.visibility.mismatch',
              'governance.visibility.enforced'
            )
          ORDER BY id`,
        [ORG_A, PROJECT_A],
      ),
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "repository.visibility.observed",
      "governance.visibility.enforced",
      "repository.visibility.observed",
      "repository.visibility.mismatch",
      "governance.visibility.enforced",
    ]);
    const observations = await runWithOrgScope(pool, ORG_A, (client) =>
      RepositoryVisibilityObservationsStore.list(client, ORG_A, PROJECT_A),
    );
    const mismatch = observations.find((observation) => observation.observedVisibility === "public");
    if (mismatch === undefined) throw new Error("expected the rejected admission to persist a public observation");

    await expect(
      runWithOrgScope(pool, ORG_A, (client) =>
        client.query(
          "UPDATE repository_visibility_observations SET observed_visibility = 'private' WHERE org_id = $1 AND observation_id = $2",
          [ORG_A, mismatch.observationId],
        ),
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      runWithOrgScope(pool, ORG_A, (client) =>
        client.query("DELETE FROM repository_visibility_observations WHERE org_id = $1 AND observation_id = $2", [
          ORG_A,
          mismatch.observationId,
        ]),
      ),
    ).rejects.toThrow(/immutable/u);

    const foreign = await runWithOrgScope(pool, ORG_B, (client) =>
      RepositoryVisibilityObservationsStore.list(client, ORG_A, PROJECT_A),
    );
    expect(foreign).toEqual([]);
  });
});

function requiredPool(pool: Pool | undefined): Pool {
  if (pool === undefined) throw new Error("TANREN_RLS_DB_TEST did not provision the application pool");
  return pool;
}
