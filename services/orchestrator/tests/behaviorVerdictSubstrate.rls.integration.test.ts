// cspell:ignore venv
// Real-Postgres proof for the rv-substrate hardening migration 0079 (#1043 +
// #1065). All decisive writes run as the restricted non-superuser tanren_app
// role; the owner connection only provisions the isolated database and seeds
// FK prerequisites. Gated on TANREN_RLS_DB_TEST like every peer *.rls.integration
// test, so the false-green + tamper proofs run in the `smoke-rls-verdict-substrate`
// recipe rather than the DB-less unit phase.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_verdict_substrate";
const PROJECT = "project_verdict_substrate";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

function databaseName(): string {
  return `tanren_verdict_substrate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

const RUN_ID = "verdict_substrate_run";
const ENV_ID = "venv_verdict_substrate";
const NODE_ID = "inode_verdict_substrate";
const BEHAVIOR_REVISION = "br_verdict_substrate";
const PERSONA_REVISION = "pr_verdict_substrate";

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-verdict')`,
    [NODE_ID, PROJECT, ORG, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'manual_canary', $4, $5, $5, $5, $5, $6, 'running', '{}'::jsonb)`,
    [ORG, RUN_ID, PROJECT, ENV_ID, D, CAS],
  );
}

async function insertVerdict(
  app: Pool,
  id: string,
  required: number,
  executed: number,
  outcome: string,
): Promise<void> {
  await runWithOrgScope(app, ORG, (client) =>
    client.query(
      `INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 1, 'stable', 'blocking', $10, $6)`,
      [ORG, id, PROJECT, RUN_ID, BEHAVIOR_REVISION, D, required, executed, outcome, CAS],
    ),
  );
}

async function insertVerdictWithEvidence(
  app: Pool,
  id: string,
  required: number,
  executed: number,
  outcome: string,
): Promise<void> {
  await runWithOrgScope(app, ORG, async (client) => {
    await client.query(
      `INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 1, 'stable', 'blocking', $10, $6)`,
      [ORG, id, PROJECT, RUN_ID, BEHAVIOR_REVISION, D, required, executed, outcome, CAS],
    );
    await client.query(
      `INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
       VALUES ($1, $2, 1, $3)`,
      [ORG, id, outcome],
    );
    await client.query(
      `INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
       SELECT $1, $2, 'assertion_' || series::text, series <= $4,
              CASE WHEN series <= $4 THEN true ELSE NULL END
         FROM generate_series(1, $3) AS series`,
      [ORG, id, required, executed],
    );
  });
}

describeDb("rv-substrate hardening (0079) — false-green + tamper conformance", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
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

  it("runs the decisive writes as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("Defect A: rejects a passed verdict that executed fewer than required", async () => {
    await expect(insertVerdict(app, "verdict_a_false_green", 12, 1, "passed")).rejects.toThrow(
      /behavior_verdicts_pass_requires_full_coverage/u,
    );
  });

  it("Defect B: rejects a passed verdict with a zero coverage floor", async () => {
    await expect(insertVerdict(app, "verdict_b_no_coverage", 0, 0, "passed")).rejects.toThrow(
      /behavior_verdicts_pass_requires_coverage_floor/u,
    );
  });

  it("accepts a passed verdict that executed every required assertion", async () => {
    await expect(insertVerdictWithEvidence(app, "verdict_accepted", 12, 12, "passed")).resolves.toBeUndefined();
    const stored = await runWithOrgScope(app, ORG, (client) =>
      client.query<{ outcome: string }>("SELECT outcome FROM behavior_verdicts WHERE org_id = $1 AND id = $2", [
        ORG,
        "verdict_accepted",
      ]),
    );
    expect(stored.rows[0]?.outcome).toBe("passed");
  });

  it("Follow-up A DECISIVE: FK-bound attempt/assertion rows must exactly match every stored count", async () => {
    await expect(
      runWithOrgScope(app, ORG, async (client) => {
        await client.query(
          `INSERT INTO behavior_verdicts
             (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
              required_assertion_count, executed_assertion_count, outcome, attempt_count,
              flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
           VALUES ($1, 'verdict_count_drift', $2, $3, $4, $5, $5, 2, 2, 'passed', 1,
                   'stable', 'blocking', $6, $5)`,
          [ORG, PROJECT, RUN_ID, BEHAVIOR_REVISION, D, CAS],
        );
        await client.query(
          `INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
           VALUES ($1, 'verdict_count_drift', 1, 'passed')`,
          [ORG],
        );
        // Only one actual assertion row backs stored required/executed=2.
        await client.query(
          `INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
           VALUES ($1, 'verdict_count_drift', 'assertion_1', true, true)`,
          [ORG],
        );
      }),
    ).rejects.toThrow(/count integrity failed/u);
  });

  it("Defect C: an accepted verdict is append-only — UPDATE and DELETE are rejected", async () => {
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("UPDATE behavior_verdicts SET outcome = 'failed_product' WHERE org_id = $1 AND id = $2", [
          ORG,
          "verdict_accepted",
        ]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*UPDATE rejected/iu);
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("DELETE FROM behavior_verdicts WHERE org_id = $1 AND id = $2", [ORG, "verdict_accepted"]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*DELETE rejected/iu);
  });

  it("Defect C: verification_assertions is append-only", async () => {
    await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `INSERT INTO verification_assertions (org_id, id, verification_run_id, expected_hash, observed_hash, outcome, timing_ms)
         VALUES ($1, 'assertion_1', $2, $3, $3, 'passed', 1)`,
        [ORG, RUN_ID, digest("assertion")],
      ),
    );
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("UPDATE verification_assertions SET outcome = 'failed' WHERE org_id = $1 AND id = 'assertion_1'", [
          ORG,
        ]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*UPDATE rejected/iu);
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("DELETE FROM verification_assertions WHERE org_id = $1 AND id = 'assertion_1'", [ORG]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*DELETE rejected/iu);
  });

  it("Defect C: verification runs allow the status/classification lifecycle but reject other mutation + DELETE", async () => {
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("UPDATE behavior_verification_runs SET status = 'completed' WHERE org_id = $1 AND id = $2", [
          ORG,
          RUN_ID,
        ]),
      ),
    ).resolves.toBeDefined();
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(
          "UPDATE behavior_verification_runs SET prepared_head_sha = 'tampered' WHERE org_id = $1 AND id = $2",
          [ORG, RUN_ID],
        ),
      ),
    ).rejects.toThrow(/immutable except status\/classification.*UPDATE rejected/iu);
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("DELETE FROM behavior_verification_runs WHERE org_id = $1 AND id = $2", [ORG, RUN_ID]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*DELETE rejected/iu);
  });
});
