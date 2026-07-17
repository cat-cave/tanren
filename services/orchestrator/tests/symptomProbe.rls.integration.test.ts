// cspell:ignore bytea iloop vassert vartifact vrun
// BH-5 real-Postgres proof. The test is intentionally skipped unless the RLS
// gate is enabled, and all assertions after provisioning use tanren_app.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";
import {
  symptomObservationHash,
  type SymptomProbeDriver,
  type SymptomProbeExecution,
} from "../src/engine/contracts/symptomProbe.js";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import { HttpSymptomProbe } from "../src/engine/probes/httpSymptomProbe.js";
import { SymptomEvidenceStore } from "../src/engine/repositories/symptomEvidence.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { SymptomProbeAdapter } from "../src/engine/probes/symptomProbeAdapter.js";
import { BaselineReproductionStage } from "../src/engine/verification/resolutionStages/baselineReproductionStage.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_USER = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_symptom_probe_a";
const ORG_B = "org_symptom_probe_b";
const PROJECT_A = "project_symptom_probe_a";
const PROJECT_B = "project_symptom_probe_b";
const SOURCE_A = "source_symptom_probe_a";
const SOURCE_B = "source_symptom_probe_b";
const LOOP_A = "iloop_symptom_probe_a";
const LOOP_B = "iloop_symptom_probe_b";
const EXPECTED = { status: 500, body: { error: "payment_failed" } };
const CORRECTED = { status: 200, body: { completed: true } };
const DIGEST = `sha256:${"d".repeat(64)}`;

function databaseName(): string {
  return `tanren_symptom_probe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  sourceId: string,
  loopId: string,
): Promise<void> {
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
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'symptom source')`,
    [sourceId, orgId, projectId],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint,
        severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'high', 'open', 'active_causal', 1, now())`,
    [orgId, loopId, projectId, sourceId, `external-${loopId}`, `fingerprint-${loopId}`],
  );
}

async function seedVerificationRun(owner: Pool, orgId: string, projectId: string, tag: string): Promise<string> {
  const nodeId = `inode_symptom_probe_${tag}`;
  const environmentId = `venv_symptom_probe_${tag}`;
  const runId = `vrun_symptom_probe_${tag}`;
  const artifactDigest = `sha256:${createHash("sha256").update(tag).digest("hex")}`;
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/symptom-probe', 'merge_batch', '[]'::jsonb, $5, $4, $6, 'ready')`,
    [nodeId, projectId, orgId, "a".repeat(40), `member-key-${tag}`, `tree-${tag}`],
  );
  await owner.query(
    `INSERT INTO cas_artifacts
       (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [orgId, artifactDigest],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [orgId, environmentId, projectId, nodeId, artifactDigest, `fingerprint-${tag}`],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id,
        plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'manual_canary', $4, $5, $6, $7, $7, $8, 'running', '{}'::jsonb)`,
    [orgId, runId, projectId, environmentId, "a".repeat(40), `tree-${tag}`, DIGEST, artifactDigest],
  );
  return runId;
}

async function seedLiveRelease(owner: Pool, orgId: string, projectId: string, tag: string): Promise<string> {
  const releaseInstanceId = `release_symptom_probe_${tag}`;
  const artifactDigest = `sha256:${createHash("sha256").update(tag).digest("hex")}`;
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id,
        source_ref, artifact_digest, provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'manual', $4, 'production', $5, 'main', $6, NULL, $7, $8, 'live')`,
    [
      orgId,
      releaseInstanceId,
      projectId,
      `app-symptom-probe-${tag}`,
      `deployment-symptom-probe-${tag}`,
      artifactDigest,
      `inode_symptom_probe_${tag}`,
      `https://example.invalid/${tag}`,
    ],
  );
  return releaseInstanceId;
}

function contract(issueLoopId: string, targetUrl: string): SymptomContractV1 {
  return {
    version: 1,
    issueLoopId,
    target: { url: targetUrl, method: "GET" },
    expectedFailingObservation: EXPECTED,
    expectedCorrectedObservation: CORRECTED,
    proofPolicy: "active_causal",
    sourceRevision: "revision-symptom-probe",
    baselineRequired: true,
  };
}

class FixedProbe implements SymptomProbeDriver {
  public constructor(
    private readonly observedObservation: Record<string, unknown>,
    private readonly marker: string,
    private readonly outcome?: "inconclusive",
  ) {}

  public async execute(_input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contract: SymptomContractV1;
    readonly verificationRunId: string;
  }): Promise<SymptomProbeExecution> {
    return {
      observedObservation: this.observedObservation,
      evidence: [
        {
          kind: "fixed_probe_receipt",
          mediaType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify({ marker: this.marker })),
          redactionClass: "none",
        },
      ],
      timingMs: 7,
      ...(this.outcome === undefined ? {} : { outcome: this.outcome }),
    };
  }
}

describe("HttpSymptomProbe", () => {
  it("uses the HTTP driver port and produces a canonical observation", async () => {
    const probe = new HttpSymptomProbe(async () => new Response(JSON.stringify(EXPECTED.body), { status: 500 }));
    const result = await probe.execute({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contract: contract(LOOP_A, "https://example.invalid/symptom"),
      verificationRunId: "vrun_http_unit",
    });
    expect(result.observedObservation).toEqual(EXPECTED);
    expect(result.evidence).toHaveLength(1);
    expect(result.outcome).toBeUndefined();
  });
});

describeDb("BH-5 symptom probe evidence — RLS and deterministic assertions", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let contracts: SymptomContractStore;
  let evidence: SymptomEvidenceStore;
  let productReleaseId: string;
  let infraReleaseId: string;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(ADMIN_URL, database, true) });
    await seedTenant(owner, ORG_A, PROJECT_A, SOURCE_A, LOOP_A);
    await seedTenant(owner, ORG_B, PROJECT_B, SOURCE_B, LOOP_B);
    await seedVerificationRun(owner, ORG_A, PROJECT_A, "a-match");
    await seedVerificationRun(owner, ORG_A, PROJECT_A, "a-mismatch");
    await seedVerificationRun(owner, ORG_B, PROJECT_B, "b-match");
    productReleaseId = await seedLiveRelease(owner, ORG_A, PROJECT_A, "a-match");
    infraReleaseId = await seedLiveRelease(owner, ORG_A, PROJECT_A, "a-mismatch");
    contracts = new SymptomContractStore(app);
    evidence = new SymptomEvidenceStore(app);
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

  it("connects as the restricted tanren_app non-superuser role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, r.rolsuper
         FROM pg_roles AS r
        WHERE r.rolname = current_user`,
    );
    expect(identity.rows[0]?.current_user).toBe(APP_USER);
    expect(identity.rows[0]?.rolsuper).toBe(false);
  });

  it("records baseline evidence/assertions, emits frozen events, and isolates orgs", async () => {
    const createdA = await contracts.create({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contract: contract(LOOP_A, "http://a"),
    });
    const createdB = await contracts.create({
      orgId: ORG_B,
      projectId: PROJECT_B,
      contract: contract(LOOP_B, "http://b"),
    });
    const matchRun = "vrun_symptom_probe_a-match";
    const mismatchRun = "vrun_symptom_probe_a-mismatch";
    const foreignRun = "vrun_symptom_probe_b-match";

    const matching = await new SymptomProbeAdapter(app, new FixedProbe(EXPECTED, "a-match")).runBaseline({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contractId: createdA.id,
      contract: createdA.contract,
      verificationRunId: matchRun,
    });
    const mismatching = await new SymptomProbeAdapter(app, new FixedProbe(CORRECTED, "a-mismatch")).runBaseline({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contractId: createdA.id,
      contract: createdA.contract,
      verificationRunId: mismatchRun,
    });
    const foreign = await new SymptomProbeAdapter(app, new FixedProbe(EXPECTED, "b-match")).runBaseline({
      orgId: ORG_B,
      projectId: PROJECT_B,
      contractId: createdB.id,
      contract: createdB.contract,
      verificationRunId: foreignRun,
    });

    expect(matching.outcome).toBe("passed");
    expect(matching.baselineOutcome).toBe("reproduced");
    expect(matching.timingMs).toBe(7);
    expect(matching.expectedHash).toBe(symptomObservationHash(EXPECTED));
    expect(matching.observedHash).toBe(matching.expectedHash);
    expect(mismatching.outcome).toBe("failed");
    expect(mismatching.baselineOutcome).toBe("not_reproduced");
    expect(mismatching.observedHash).toBe(symptomObservationHash(CORRECTED));
    expect(mismatching.observedHash).not.toBe(mismatching.expectedHash);

    const assertionsA = await evidence.listAssertions(ORG_A, matchRun);
    const assertionsMismatch = await evidence.listAssertions(ORG_A, mismatchRun);
    expect(assertionsA).toHaveLength(1);
    expect(assertionsA[0]).toMatchObject({
      id: matching.assertionId,
      expectedHash: matching.expectedHash,
      observedHash: matching.observedHash,
      outcome: "passed",
      timingMs: 7,
    });
    expect(assertionsMismatch[0]?.outcome).toBe("failed");
    expect((await evidence.listArtifacts(ORG_A, PROJECT_A)).length).toBe(4);
    expect((await evidence.listArtifacts(ORG_B, PROJECT_B)).length).toBe(2);

    const eventNames = ["symptom.baseline.started", "symptom.baseline.observed", "symptom.assertion.recorded"];
    const eventsA = await runWithOrgScope(app, ORG_A, async (client) => {
      const result = await client.query<{ event_type: string }>(
        `SELECT event_type
           FROM events
          WHERE org_id = $1 AND project_id = $2 AND event_type = ANY($3::text[])
          ORDER BY id`,
        [ORG_A, PROJECT_A, eventNames],
      );
      return result.rows.map((row) => row.event_type);
    });
    expect(eventsA).toEqual([...eventNames, ...eventNames]);

    expect(await evidence.listAssertions(ORG_A, foreignRun)).toEqual([]);
    expect(await evidence.listArtifacts(ORG_A, PROJECT_B)).toEqual([]);
    expect(await new PgCasByteStore(app).has(ORG_A, foreign.evidence[0]!.digest)).toBe(false);
    const foreignEventsVisibleToA = await runWithOrgScope(app, ORG_A, (client) =>
      client.query("SELECT 1 FROM events WHERE org_id = $1 AND project_id = $2", [ORG_B, PROJECT_B]),
    );
    expect(foreignEventsVisibleToA.rowCount).toBe(0);

    const storedArtifacts = await owner.query(
      "SELECT cas_digest, project_id FROM verification_artifacts WHERE org_id = $1 ORDER BY created_at, id",
      [ORG_A],
    );
    expect(storedArtifacts.rows).toHaveLength(4);
    expect(storedArtifacts.rows.every((row) => row.project_id === PROJECT_A)).toBe(true);
    expect(storedArtifacts.rows.every((row) => typeof row.cas_digest === "string")).toBe(true);
  });

  it("runs the ResolutionStage through the real event store and keeps infra failure awaiting reproduction", async () => {
    const stagedContract = await contracts.create({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contract: contract(LOOP_A, "http://a/staged"),
    });
    const jobs = new ResolutionJobStore(app);
    const productJob: ResolutionJob = {
      id: "rjob_baseline_product",
      orgId: ORG_A,
      projectId: PROJECT_A,
      issueLoopId: LOOP_A,
      contractId: stagedContract.id,
      releaseInstanceId: productReleaseId,
      stage: "baseline",
      state: "running",
      leaseOwner: "worker_baseline",
      leaseExpiry: "2026-01-01T00:01:00.000Z",
      idempotencyKey: "iloop_symptom_probe_a:baseline:product",
      attempt: 2,
    };
    const infraJob: ResolutionJob = {
      ...productJob,
      id: "rjob_baseline_infra",
      releaseInstanceId: infraReleaseId,
      idempotencyKey: "iloop_symptom_probe_a:baseline:infra",
    };
    await jobs.enqueue({
      orgId: productJob.orgId,
      projectId: productJob.projectId,
      id: productJob.id,
      issueLoopId: productJob.issueLoopId,
      contractId: productJob.contractId,
      releaseInstanceId: productJob.releaseInstanceId,
      stage: productJob.stage,
      idempotencyKey: productJob.idempotencyKey,
    });
    await jobs.enqueue({
      orgId: infraJob.orgId,
      projectId: infraJob.projectId,
      id: infraJob.id,
      issueLoopId: infraJob.issueLoopId,
      contractId: infraJob.contractId,
      releaseInstanceId: infraJob.releaseInstanceId,
      stage: infraJob.stage,
      idempotencyKey: infraJob.idempotencyKey,
    });

    const product = await new BaselineReproductionStage({
      pool: app,
      probe: new SymptomProbeAdapter(app, new FixedProbe(EXPECTED, "stage-product")),
      verificationRunId: () => "vrun_baseline_product",
    }).run(productJob, {});

    expect(product).toMatchObject({
      outcome: "passed",
      classification: "product_failure",
      verificationRunId: "vrun_baseline_product",
    });
    expect(product.assertionIds).toHaveLength(1);
    expect(product.evidenceRefs).toHaveLength(2);

    const infra = await new BaselineReproductionStage({
      pool: app,
      probe: new SymptomProbeAdapter(app, new FixedProbe(EXPECTED, "stage-infra", "inconclusive")),
      verificationRunId: () => "vrun_baseline_infra",
    }).run(infraJob, {});

    expect(infra).toMatchObject({
      outcome: "inconclusive",
      classification: "infra_failure",
      verificationRunId: "vrun_baseline_infra",
    });

    const observed = await runWithOrgScope(app, ORG_A, async (client) => {
      const runs = await client.query<{ id: string; stage: string; classification: string; status: string }>(
        `SELECT id, stage, classification, status
           FROM behavior_verification_runs
          WHERE org_id = $1 AND id = ANY($2::text[])
          ORDER BY id`,
        [ORG_A, ["vrun_baseline_infra", "vrun_baseline_product"]],
      );
      const loop = await client.query<{ state: string }>(
        "SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2",
        [ORG_A, LOOP_A],
      );
      const events = await client.query<{ event_type: string; outcome: string }>(
        `SELECT event_type, payload->>'outcome' AS outcome
           FROM events
          WHERE org_id = $1
            AND project_id = $2
            AND payload->>'verificationRunId' = ANY($3::text[])
          ORDER BY id`,
        [ORG_A, PROJECT_A, ["vrun_baseline_product", "vrun_baseline_infra"]],
      );
      return { runs: runs.rows, loop: loop.rows[0], events: events.rows };
    });
    expect(observed.runs).toEqual([
      { id: "vrun_baseline_infra", stage: "baseline", classification: "infra_failure", status: "failed" },
      { id: "vrun_baseline_product", stage: "baseline", classification: "product_failure", status: "completed" },
    ]);
    expect(observed.loop).toEqual({ state: "awaiting_reproduction" });
    expect(observed.events).toEqual([
      { event_type: "symptom.baseline.started", outcome: null },
      { event_type: "symptom.baseline.observed", outcome: "reproduced" },
      { event_type: "symptom.assertion.recorded", outcome: "passed" },
      { event_type: "symptom.baseline.started", outcome: null },
      { event_type: "symptom.baseline.observed", outcome: "inconclusive" },
      { event_type: "symptom.assertion.recorded", outcome: "inconclusive" },
    ]);

    const foreignRuns = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT 1 FROM behavior_verification_runs WHERE org_id = $1", [ORG_A]),
    );
    expect(foreignRuns.rowCount).toBe(0);
  });
});
