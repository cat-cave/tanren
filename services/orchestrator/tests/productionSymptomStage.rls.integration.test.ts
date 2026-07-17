// cspell:ignore bytea iloop venv vrun
// BH-10 real-Postgres conformance. All stage writes and reads use the restricted
// tanren_app role; the owner connection only provisions the isolated database.
// Gated on TANREN_RLS_DB_TEST (like every peer *.rls.integration.test), so the
// decisive false-green proof runs in the `smoke-rls-production-verification`
// recipe (part of the CI `check` job) rather than the DB-less unit phase.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";
import { SymptomEvidenceStore } from "../src/engine/repositories/symptomEvidence.js";
import { ProductionSymptomStage } from "../src/engine/verification/resolutionStages/productionSymptomStage.js";

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_production_symptom_a";
const ORG_B = "org_production_symptom_b";
const PROJECT_A = "project_production_symptom_a";
const PROJECT_B = "project_production_symptom_b";
const EXPECTED_FAILURE = { status: 200, body: { status: "still_broken" } };
const EXPECTED_CORRECTION = { status: 200, body: { status: "fixed" } };

interface HttpFixture {
  readonly url: string;
  readonly close: () => Promise<void>;
}

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

async function seedTenant(owner: Pool, orgId: string, projectId: string, releaseUrl: string) {
  const suffix = orgId.endsWith("_a") ? "a" : "b";
  const sourceId = `source_production_symptom_${suffix}`;
  const loopId = `iloop_production_symptom_${suffix}`;
  const nodeId = `inode_production_symptom_${suffix}`;
  const environmentId = `venv_production_symptom_${suffix}`;
  const previewEnvironmentId = `zz_preview_production_symptom_${suffix}`;
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
  // This lexically later ready environment proves the binding query is limited
  // to deployment_target='production', not merely digest/node/lifecycle.
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'preview', $6, $6, 'ready')`,
    [orgId, previewEnvironmentId, projectId, nodeId, artifactDigest, `preview-fingerprint-${suffix}`],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', $4, 'production', $5, $6, $7, NULL, $8, $9, 'live')`,
    [orgId, releaseId, projectId, `app-${suffix}`, `deployment-${suffix}`, headSha, artifactDigest, nodeId, releaseUrl],
  );
  return { loopId, releaseId, artifactDigest, environmentId };
}

function contract(issueLoopId: string, decoyUrl: string): SymptomContractV1 {
  return {
    version: 1,
    issueLoopId,
    // A green decoy makes this a real wrong-surface negative control: using
    // contract.target instead of release_instances.url would falsely pass.
    target: { url: `${decoyUrl}/symptom`, method: "GET" },
    expectedFailingObservation: EXPECTED_FAILURE,
    expectedCorrectedObservation: EXPECTED_CORRECTION,
    proofPolicy: "active_causal",
    sourceRevision: "production-symptom-revision",
    baselineRequired: true,
  };
}

async function startHttpFixture(
  respond: (path: string) => { readonly body: Record<string, unknown>; readonly status?: number },
): Promise<HttpFixture> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    const result = respond(path);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function assertGenericChecksGreen(url: string): Promise<void> {
  const [reachability, demo] = await Promise.all([fetch(url), fetch(`${url}/health`)]);
  expect([200, 401, 403]).toContain(reachability.status);
  expect(demo.status).toBe(200);
  await expect(demo.json()).resolves.toEqual({ status: "healthy" });
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

const RLS_DB_ENABLED = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = RLS_DB_ENABLED ? describe : describe.skip;

describeDb("BH-10 production symptom stage — RLS false-green conformance", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let production: HttpFixture;
  let decoy: HttpFixture;
  let cosmeticFix = true;
  const productionRequests: string[] = [];
  const decoyRequests: string[] = [];

  beforeAll(async () => {
    production = await startHttpFixture((path) => {
      productionRequests.push(path);
      if (path === "/health") return { body: { status: "healthy" } };
      if (path === "/symptom") return { body: cosmeticFix ? { status: "still_broken" } : { status: "fixed" } };
      return { body: { status: "reachable" } };
    });
    decoy = await startHttpFixture((path) => {
      decoyRequests.push(path);
      return { body: path === "/symptom" ? { status: "fixed" } : { status: "healthy" } };
    });
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
    await production?.close();
    await decoy?.close();
  }, 30_000);

  it("runs stage reads/writes as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("keeps generic green checks from masking a broken live-production symptom", async () => {
    const a = await seedTenant(owner, ORG_A, PROJECT_A, production.url);
    const b = await seedTenant(owner, ORG_B, PROJECT_B, production.url);
    const contracts = new SymptomContractStore(app);
    const storedContract = await contracts.create({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contract: contract(a.loopId, decoy.url),
    });
    const jobs = new ResolutionJobStore(app);

    // The cosmetic change makes the generic production checks green. Its locked
    // symptom remains broken; the decoy contract URL is green too, so only a
    // release-derived probe target can make this assertion fail correctly.
    cosmeticFix = true;
    await assertGenericChecksGreen(production.url);
    const falseGreenJob = await queuedProductionJob(
      jobs,
      ORG_A,
      PROJECT_A,
      a.loopId,
      storedContract.id,
      a.releaseId,
      "rjob_production_false_green",
    );
    const falseGreen = await new ProductionSymptomStage({ pool: app }).run(falseGreenJob, {});
    expect(falseGreen).toMatchObject({ outcome: "failed", classification: "product_failure" });
    expect(productionRequests).toContain("/symptom");
    expect(decoyRequests).not.toContain("/symptom");

    // The real repair retains the same two green generic checks and now makes
    // the exact same production symptom assertion pass.
    cosmeticFix = false;
    await assertGenericChecksGreen(production.url);
    const fixedJob = await queuedProductionJob(
      jobs,
      ORG_A,
      PROJECT_A,
      a.loopId,
      storedContract.id,
      a.releaseId,
      "rjob_production_fixed",
    );
    const fixed = await new ProductionSymptomStage({ pool: app }).run(fixedJob, {});
    expect(fixed).toMatchObject({ outcome: "passed", classification: "product_resolved" });
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
      client.query<{
        artifact_digest: string;
        classification: string;
        environment_id: string;
        stage: string;
        status: string;
      }>(
        `SELECT artifact_digest, classification, environment_id, stage, status
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
        environment_id: a.environmentId,
        stage: "production",
        status: "completed",
      },
      {
        artifact_digest: a.artifactDigest,
        classification: "product_resolved",
        environment_id: a.environmentId,
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
