// cspell:ignore venv
// rv-24 — real-Postgres proof for the exportable proof bundle. Every decisive read runs
// as the restricted non-superuser `tanren_app` role; the owner connection only
// provisions the DB and seeds FK prerequisites. Gated on TANREN_RLS_DB_TEST like every
// peer *.rls.integration test, so these run in `smoke-rls-proof-bundle`. Proves: the
// export assembles a valid bundle from REAL persisted rows, a FAILED verdict exports as
// failed (no laundering), a tampered exported bundle re-verifies INVALID, and a cross-org
// export sees ZERO rows.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProofBundleStore } from "../src/engine/verification/acceptance/proofBundleStore.js";
import { verifyProofBundle } from "../src/engine/verification/acceptance/proofBundle.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_pb_a";
const ORG_B = "org_pb_b";
const PROJECT = "project_pb";
const NODE_ID = "inode_pb";
const ENV_ID = "venv_pb";
const PERSONA_REVISION = "pr_pb";
const BEHAVIOR_REVISION = "br_pb";
const RUN_PASS = "run_pb_pass";
const RUN_FAIL = "run_pb_fail";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

function databaseName(): string {
  return `tanren_proof_bundle_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedOrg(owner: Pool, org: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
}

async function seedRun(owner: Pool, org: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO behavior_verification_runs (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'post_merge_production', $4, $5, $5, $5, $5, $6, 'completed', '{}'::jsonb)`,
    [org, runId, PROJECT, ENV_ID, D, CAS],
  );
}

async function seedVerdict(
  owner: Pool,
  org: string,
  id: string,
  runId: string,
  outcome: string,
  required: number,
  executed: number,
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 1, 'stable', 'blocking', $10, $6)`,
      [org, id, PROJECT, runId, BEHAVIOR_REVISION, D, required, executed, outcome, CAS],
    );
    await client.query(
      `INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
       VALUES ($1, $2, 1, $3)`,
      [org, id, outcome],
    );
    await client.query(
      `INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
       SELECT $1, $2, 'assertion_' || series::text, series <= $4,
              CASE WHEN series <= $4 THEN true ELSE NULL END
         FROM generate_series(1, $3) AS series`,
      [org, id, required, executed],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seedTenant(owner: Pool): Promise<void> {
  await seedOrg(owner, ORG_A);
  await seedOrg(owner, ORG_B);
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG_A],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-pb')`,
    [NODE_ID, PROJECT, ORG_A, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG_A, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG_A, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG_A, PROJECT, PERSONA_REVISION, D],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG_A, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
  await seedRun(owner, ORG_A, RUN_PASS);
  await seedRun(owner, ORG_A, RUN_FAIL);
  await seedVerdict(owner, ORG_A, "verdict_pass", RUN_PASS, "passed", 12, 12);
  await seedVerdict(owner, ORG_A, "verdict_fail", RUN_FAIL, "failed_product", 12, 0);
}

describeDb("rv-24 exportable proof bundle — real reads, isolation, tamper", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: ProofBundleStore;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    store = new ProofBundleStore(app);
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

  it("runs the decisive reads as the non-superuser tanren_app role", async () => {
    const identity = await runWithOrgScope(app, ORG_A, (client) =>
      client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("exports a valid, tamper-evident bundle from the real persisted rows", async () => {
    const bundle = await store.exportForRun({ orgId: ORG_A, projectId: PROJECT, runId: RUN_PASS });
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    expect(bundle.evidence.run.status).toBe("completed");
    expect(bundle.evidence.environment?.environmentId).toBe(ENV_ID);
    expect(bundle.evidence.verdicts.map((v) => v.outcome)).toEqual(["passed"]);
    expect(verifyProofBundle(bundle).valid).toBe(true);
  });

  it("a FAILED verdict exports as failed — the bundle cannot launder it into passed", async () => {
    const bundle = await store.exportForRun({ orgId: ORG_A, projectId: PROJECT, runId: RUN_FAIL });
    expect(bundle?.evidence.verdicts[0]?.outcome).toBe("failed_product");
  });

  it("DECISIVE: tampering an exported bundle's verdict re-verifies INVALID", async () => {
    const bundle = await store.exportForRun({ orgId: ORG_A, projectId: PROJECT, runId: RUN_PASS });
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    const tampered = structuredClone(bundle);
    (tampered.evidence.verdicts as { executedAssertionCount: number }[])[0].executedAssertionCount = 1;
    const result = verifyProofBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.divergedAt).toBe("verdicts");
  });

  it("a cross-org export sees ZERO rows — org B cannot export org A's run", async () => {
    const bundle = await store.exportForRun({ orgId: ORG_B, projectId: PROJECT, runId: RUN_PASS });
    expect(bundle).toBeUndefined();
  });
});
