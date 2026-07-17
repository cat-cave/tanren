// cspell:ignore iloop vrun
// This focused smoke proof locks the baseline finalizer's full lineage
// predicate against real Postgres under the restricted tanren_app role.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";
import { finalizeBaselineVerificationRun } from "../src/engine/verification/resolutionStages/baselineReproductionStage.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_USER = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_baseline_finalize";
const PROJECT_ID = "project_baseline_finalize";
const SOURCE_ID = "source_baseline_finalize";
const LOOP_ID = "iloop_baseline_finalize";
const DIGEST = `sha256:${"a".repeat(64)}`;

function databaseName(): string {
  return `tanren_baseline_finalize_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG_ID],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'baseline source')`,
    [SOURCE_ID, ORG_ID, PROJECT_ID],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint,
        severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, 'baseline-finalize', 1, 'fingerprint', 'high', 'open', 'active_causal', 1, now())`,
    [ORG_ID, LOOP_ID, PROJECT_ID, SOURCE_ID],
  );
}

async function seedVerificationRun(owner: Pool, tag: string): Promise<string> {
  const nodeId = `inode_baseline_finalize_${tag}`;
  const environmentId = `venv_baseline_finalize_${tag}`;
  const runId = `vrun_baseline_finalize_${tag}`;
  const artifactDigest = `sha256:${createHash("sha256").update(tag).digest("hex")}`;
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/baseline-finalize', 'merge_batch', '[]'::jsonb, $5, $4, $6, 'ready')`,
    [nodeId, PROJECT_ID, ORG_ID, "a".repeat(40), `member-${tag}`, `tree-${tag}`],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [ORG_ID, artifactDigest],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG_ID, environmentId, PROJECT_ID, nodeId, artifactDigest, `fingerprint-${tag}`],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id,
        plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'manual_canary', $4, $5, $6, $7, $7, $8, 'running', '{}'::jsonb)`,
    [ORG_ID, runId, PROJECT_ID, environmentId, "a".repeat(40), `tree-${tag}`, DIGEST, artifactDigest],
  );
  return runId;
}

function contract(): SymptomContractV1 {
  return {
    version: 1,
    issueLoopId: LOOP_ID,
    target: { url: "https://example.invalid/baseline-finalize" },
    expectedFailingObservation: { status: 500 },
    expectedCorrectedObservation: { status: 200 },
    proofPolicy: "active_causal",
    sourceRevision: "baseline-finalize-revision",
    baselineRequired: true,
  };
}

describeDb("baseline reproduction finalization predicate — RLS", () => {
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

  it("uses tanren_app as a non-superuser", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean }>(
      "SELECT current_user, r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: APP_USER, rolsuper: false });
  });

  it("matches zero rows for a wrong stage or resolution job", async () => {
    const contracts = new SymptomContractStore(app);
    const stagedContract = await contracts.create({ orgId: ORG_ID, projectId: PROJECT_ID, contract: contract() });
    const jobs = new ResolutionJobStore(app);
    const expectedJob = {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      id: "rjob_baseline_finalize_expected",
      issueLoopId: LOOP_ID,
      contractId: stagedContract.id,
      stage: "baseline" as const,
      idempotencyKey: "iloop_baseline_finalize:expected",
    };
    const otherJob = {
      ...expectedJob,
      id: "rjob_baseline_finalize_other",
      idempotencyKey: "iloop_baseline_finalize:other",
    };
    await jobs.enqueue(expectedJob);
    await jobs.enqueue(otherJob);

    const wrongStageRun = await seedVerificationRun(owner, "wrong-stage");
    const wrongJobRun = await seedVerificationRun(owner, "wrong-job");
    await owner.query(
      "UPDATE behavior_verification_runs SET stage = $3, resolution_job_id = $4 WHERE org_id = $1 AND id = $2",
      [ORG_ID, wrongStageRun, "production", expectedJob.id],
    );
    await owner.query(
      "UPDATE behavior_verification_runs SET stage = 'baseline', resolution_job_id = $3 WHERE org_id = $1 AND id = $2",
      [ORG_ID, wrongJobRun, otherJob.id],
    );

    const input = {
      orgId: ORG_ID,
      resolutionJobId: expectedJob.id,
      classification: "product_failure" as const,
      status: "completed" as const,
    };
    await expect(finalizeBaselineVerificationRun(app, { ...input, verificationRunId: wrongStageRun })).resolves.toBe(0);
    await expect(finalizeBaselineVerificationRun(app, { ...input, verificationRunId: wrongJobRun })).resolves.toBe(0);

    const untouched = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ id: string; classification: string | null; status: string }>(
        "SELECT id, classification, status FROM behavior_verification_runs WHERE org_id = $1 AND id = ANY($2::text[]) ORDER BY id",
        [ORG_ID, [wrongJobRun, wrongStageRun]],
      ),
    );
    expect(untouched.rows).toEqual([
      { id: wrongJobRun, classification: null, status: "running" },
      { id: wrongStageRun, classification: null, status: "running" },
    ]);
  });
});
