// cspell:ignore bytea iloop venv vrun
// BH-10 real-Postgres conformance. All stage writes and reads use the restricted
// tanren_app role; the owner connection only provisions the isolated database.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";
import type { SymptomProbeDriver, SymptomProbeExecution } from "../src/engine/contracts/symptomProbe.js";
import { SymptomProbeAdapter } from "../src/engine/probes/symptomProbeAdapter.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";
import { SymptomEvidenceStore } from "../src/engine/repositories/symptomEvidence.js";
import { ProductionSymptomStage } from "../src/engine/verification/resolutionStages/productionSymptomStage.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_production_symptom_a";
const ORG_B = "org_production_symptom_b";
const PROJECT_A = "project_production_symptom_a";
const PROJECT_B = "project_production_symptom_b";
const EXPECTED_FAILURE = { status: 200, body: { status: "still_broken" } };
const EXPECTED_CORRECTION = { status: 200, body: { status: "fixed" } };

function databaseName(): string {
  return `tanren_production_symptom_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(database: string, appRole = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (appRole) {
    url.username = "tanren_app";
    url.password = APP_PASSWORD;
  }
  return url.toString();
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

async function seedTenant(owner: Pool, orgId: string, projectId: string) {
  const suffix = orgId.endsWith("_a") ? "a" : "b";
  const sourceId = `source_production_symptom_${suffix}`;
  const loopId = `iloop_production_symptom_${suffix}`;
  const nodeId = `inode_production_symptom_${suffix}`;
  const environmentId = `venv_production_symptom_${suffix}`;
  const releaseId = `release_production_symptom_${suffix}`;
  const artifactDigest = digest(`artifact-${suffix}`);
  const headSha = "a".repeat(40);
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name) VALUES ($1, $2, $3, 'issues', 'source')`,
    [sourceId, orgId, projectId],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint, severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'high', 'open', 'active_causal', 1, now())`,
    [orgId, loopId, projectId, sourceId, `external-${suffix}`, `fingerprint-${suffix}`],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/production-symptom', 'merge_batch', '[]'::jsonb, $5, $4, $6, 'ready')`,
    [nodeId, projectId, orgId, headSha, `member-${suffix}`, `tree-${suffix}`],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [orgId, artifactDigest],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'production', $6, $6, 'ready')`,
    [orgId, environmentId, projectId, nodeId, artifactDigest, `fingerprint-${suffix}`],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', $4, 'production', $5, $6, $7, NULL, $8, $9, 'live')`,
    [
      orgId,
      releaseId,
      projectId,
      `app-${suffix}`,
      `deployment-${suffix}`,
      headSha,
      artifactDigest,
      nodeId,
      `https://${suffix}.example.test`,
    ],
  );
  return { loopId, releaseId, artifactDigest };
}

function contract(issueLoopId: string): SymptomContractV1 {
  return {
    version: 1,
    issueLoopId,
    target: { url: "https://production.example.test/symptom", method: "GET" },
    expectedFailingObservation: EXPECTED_FAILURE,
    expectedCorrectedObservation: EXPECTED_CORRECTION,
    proofPolicy: "active_causal",
    sourceRevision: "production-symptom-revision",
    baselineRequired: true,
  };
}

class FixedProbe implements SymptomProbeDriver {
  public constructor(private readonly observation: Record<string, unknown>) {}

  public async execute(_input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contract: SymptomContractV1;
    readonly verificationRunId: string;
  }): Promise<SymptomProbeExecution> {
    return {
      observedObservation: this.observation,
      evidence: [],
      timingMs: 4,
    };
  }
}

async function queuedProductionJob(
  store: ResolutionJobStore,
  orgId: string,
  projectId: string,
  issueLoopId: string,
  contractId: string,
  releaseInstanceId: string,
  id: string,
): Promise<ResolutionJob> {
  await store.enqueue({
    orgId,
    projectId,
    id,
    issueLoopId,
    contractId,
    releaseInstanceId,
    stage: "production",
    idempotencyKey: `${id}:production`,
  });
  const job = await store.claimNext({ orgId, leaseOwner: `worker-${id}` });
  if (job === undefined) throw new Error("expected queued production job");
  return job;
}

describeDb("BH-10 production symptom stage — RLS false-green conformance", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
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

  it("binds the live sha256 artifact and never lets unrelated green checks mask the locked symptom", async () => {
    const a = await seedTenant(owner, ORG_A, PROJECT_A);
    const b = await seedTenant(owner, ORG_B, PROJECT_B);
    const contracts = new SymptomContractStore(app);
    const storedContract = await contracts.create({ orgId: ORG_A, projectId: PROJECT_A, contract: contract(a.loopId) });
    const jobs = new ResolutionJobStore(app);

    // The unrelated reachability and generic-demo checks are intentionally not
    // inputs to this stage. The locked symptom is still observed as broken.
    const falseGreenJob = await queuedProductionJob(
      jobs,
      ORG_A,
      PROJECT_A,
      a.loopId,
      storedContract.id,
      a.releaseId,
      "rjob_production_false_green",
    );
    const falseGreen = await new ProductionSymptomStage({
      pool: app,
      probe: new SymptomProbeAdapter(app, new FixedProbe(EXPECTED_FAILURE)),
    }).run(falseGreenJob, {});
    expect(falseGreen).toMatchObject({ outcome: "failed", classification: "product_failure" });

    const fixedJob = await queuedProductionJob(
      jobs,
      ORG_A,
      PROJECT_A,
      a.loopId,
      storedContract.id,
      a.releaseId,
      "rjob_production_fixed",
    );
    const fixed = await new ProductionSymptomStage({
      pool: app,
      probe: new SymptomProbeAdapter(app, new FixedProbe(EXPECTED_CORRECTION)),
    }).run(fixedJob, {});
    expect(fixed).toMatchObject({ outcome: "passed", classification: "product_failure" });
    const assertions = new SymptomEvidenceStore(app);
    await expect(assertions.listAssertions(ORG_A, falseGreen.verificationRunId)).resolves.toMatchObject([
      { outcome: "failed" },
    ]);
    await expect(assertions.listAssertions(ORG_A, fixed.verificationRunId)).resolves.toMatchObject([
      { outcome: "passed" },
    ]);

    const events = await runWithOrgScope(app, ORG_A, async (client) => {
      const result = await client.query<{ event_type: string; payload: { artifactDigest?: string } }>(
        `SELECT event_type, payload
           FROM events
          WHERE org_id = $1 AND project_id = $2
            AND event_type = ANY($3::text[])
          ORDER BY id`,
        [
          ORG_A,
          PROJECT_A,
          [
            "deployment.artifact.bound",
            "symptom.verification.started",
            "symptom.verification.failed",
            "symptom.verification.passed",
          ],
        ],
      );
      return result.rows;
    });
    expect(events.map((event) => event.event_type)).toEqual([
      "deployment.artifact.bound",
      "symptom.verification.started",
      "symptom.verification.failed",
      "deployment.artifact.bound",
      "symptom.verification.started",
      "symptom.verification.passed",
    ]);
    expect(events[0]?.payload.artifactDigest).toBe(a.artifactDigest);

    const runs = await runWithOrgScope(app, ORG_A, (client) =>
      client.query<{ artifact_digest: string; classification: string; stage: string; status: string }>(
        `SELECT artifact_digest, classification, stage, status
           FROM behavior_verification_runs
          WHERE org_id = $1 AND resolution_job_id = ANY($2::text[])
          ORDER BY resolution_job_id`,
        [ORG_A, [falseGreenJob.id, fixedJob.id]],
      ),
    );
    expect(runs.rows).toEqual([
      {
        artifact_digest: a.artifactDigest,
        classification: "product_failure",
        stage: "production",
        status: "completed",
      },
      {
        artifact_digest: a.artifactDigest,
        classification: "product_failure",
        stage: "production",
        status: "completed",
      },
    ]);

    const foreignReleaseVisible = await runWithOrgScope(app, ORG_A, (client) =>
      client.query("SELECT 1 FROM release_instances WHERE org_id = $1 AND id = $2", [ORG_B, b.releaseId]),
    );
    expect(foreignReleaseVisible.rowCount).toBe(0);
  });
});
