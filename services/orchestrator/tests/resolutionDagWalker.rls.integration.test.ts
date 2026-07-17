// cspell:ignore bytea iloop venv vrun
// Real composition proof for bh-6b: the worker's actual ResolutionJobStore and
// registered BaselineReproductionStage claim, fence, execute, persist, transition,
// and settle durable work under the restricted runtime database role.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import { ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";
import {
  BaselineReproductionStage,
  createResolutionStageRegistry,
} from "../src/engine/verification/resolutionStages/index.js";

const describeDb = process.env["TANREN_RLS_DB_TEST"] === "1" ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_resolution_walker";
const PROJECT_ID = "project_resolution_walker";
const LOOP_ID = "iloop_resolution_walker";
const SOURCE_ID = "source_resolution_walker";

function databaseName(): string {
  return `tanren_resolution_walker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function startProbe(): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "still_broken" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("resolution walker fixture did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}/symptom`,
    calls: () => calls,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seedRuntime(owner: Pool): Promise<void> {
  const nodeId = "inode_resolution_walker";
  const environmentId = "venv_resolution_walker";
  const releaseId = "release_resolution_walker";
  const artifactDigest = digest("resolution-walker-artifact");
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG_ID],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/resolution.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'resolution walker source')`,
    [SOURCE_ID, ORG_ID, PROJECT_ID],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint,
        severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, 'resolution-walker', 1, 'fingerprint',
             'high', 'open', 'active_causal', 1, now())`,
    [ORG_ID, LOOP_ID, PROJECT_ID, SOURCE_ID],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/resolution-walker', 'merge_batch',
             '[]'::jsonb, 'member-resolution-walker', $4, 'tree-resolution-walker', 'ready')`,
    [nodeId, PROJECT_ID, ORG_ID, "a".repeat(40)],
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
     VALUES ($1, $2, $3, $4, $5, 'production', 'fingerprint', 'lease', 'ready')`,
    [ORG_ID, environmentId, PROJECT_ID, nodeId, artifactDigest],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref,
        artifact_digest, provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', 'app-resolution-walker', 'production',
             'deploy-resolution-walker', $4, $5, NULL, $6, 'https://example.invalid', 'live')`,
    [ORG_ID, releaseId, PROJECT_ID, "a".repeat(40), artifactDigest, nodeId],
  );
}

function contract(url: string): SymptomContractV1 {
  return {
    version: 1,
    issueLoopId: LOOP_ID,
    target: { url },
    expectedFailingObservation: { status: 500, body: { status: "still_broken" } },
    expectedCorrectedObservation: { status: 200 },
    proofPolicy: "active_causal",
    sourceRevision: "resolution-walker-revision",
    baselineRequired: true,
  };
}

describeDb("ResolutionDagWalker — real registry, RLS, and periodic recovery", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let jobs: ResolutionJobStore;
  let contractId: string;
  let probe: Awaited<ReturnType<typeof startProbe>>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
    probe = await startProbe();
    await seedRuntime(owner);
    contractId = (
      await new SymptomContractStore(app).create({
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        contract: contract(probe.url),
      })
    ).id;
    jobs = new ResolutionJobStore(app);
  }, 60_000);

  afterAll(async () => {
    await probe?.close();
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

  it("uses tanren_app without superuser or RLS-bypass privileges", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("periodically claims a dropped-notification job with the real registry and persists its baseline result", async () => {
    await jobs.enqueue({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      id: "rjob_resolution_periodic",
      issueLoopId: LOOP_ID,
      contractId,
      stage: "baseline",
      idempotencyKey: "resolution-periodic",
    });
    const stages = createResolutionStageRegistry({ pool: app });
    expect(stages.get("baseline")).toBeInstanceOf(BaselineReproductionStage);
    const walker = new ResolutionDagWalker({
      store: jobs,
      orgIds: async () => [ORG_ID],
      stages,
      leaseOwner: "resolution-periodic-walker",
      leaseMs: 30_000,
    });

    await expect(walker.tick()).resolves.toEqual([
      { orgId: ORG_ID, recoveredJobIds: [], claimedJobIds: ["rjob_resolution_periodic"] },
    ]);
    const [job, run, loop] = await runWithOrgScope(app, ORG_ID, async (client) => {
      const rows = await Promise.all([
        client.query("SELECT state, attempt FROM resolution_jobs WHERE org_id = $1 AND id = $2", [
          ORG_ID,
          "rjob_resolution_periodic",
        ]),
        client.query(
          "SELECT stage, resolution_job_id, classification, status FROM behavior_verification_runs WHERE resolution_job_id = $1",
          ["rjob_resolution_periodic"],
        ),
        client.query("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]),
      ]);
      return rows.map((row) => row.rows[0]);
    });
    expect(job).toEqual({ state: "completed", attempt: 1 });
    expect(run).toEqual({
      stage: "baseline",
      resolution_job_id: "rjob_resolution_periodic",
      classification: "product_failure",
      status: "completed",
    });
    expect(loop).toEqual({ state: "reproduced" });
    expect(probe.calls()).toBe(1);
    await expect(walker.tick()).resolves.toEqual([{ orgId: ORG_ID, recoveredJobIds: [], claimedJobIds: [] }]);
    expect(probe.calls()).toBe(1);
  });

  it("recovers after a persisted mid-tick stage result without duplicating the probe or receipt", async () => {
    await runWithOrgScope(app, ORG_ID, (client) =>
      client.query("UPDATE issue_loops SET state = 'open' WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]),
    );
    await jobs.enqueue({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      id: "rjob_resolution_recovery",
      issueLoopId: LOOP_ID,
      contractId,
      stage: "baseline",
      idempotencyKey: "resolution-recovery",
    });
    const crashed = await jobs.claimNext({ orgId: ORG_ID, leaseOwner: "crashed-worker", leaseMs: 30_000 });
    if (crashed === undefined) throw new Error("expected crash fixture job to claim");
    const stages = createResolutionStageRegistry({ pool: app });
    const stage = stages.get("baseline");
    if (stage === undefined) throw new Error("baseline stage must be registered");
    const before = probe.calls();
    await stage.run(crashed, {});
    expect(probe.calls() - before).toBe(1);
    // Model the precise crash window after receipt finalization but before its
    // separate issue-loop transition commits. Recovery must replay that CAS.
    await owner.query("UPDATE issue_loops SET state = 'open' WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]);
    await runWithOrgScope(app, ORG_ID, (client) =>
      client.query(
        "UPDATE resolution_jobs SET lease_expiry = now() - interval '1 second' WHERE org_id = $1 AND id = $2",
        [ORG_ID, "rjob_resolution_recovery"],
      ),
    );
    const walker = new ResolutionDagWalker({
      store: jobs,
      orgIds: async () => [ORG_ID],
      stages,
      leaseOwner: "recovery-walker",
      leaseMs: 30_000,
    });

    await expect(walker.tick()).resolves.toEqual([
      { orgId: ORG_ID, recoveredJobIds: ["rjob_resolution_recovery"], claimedJobIds: [] },
    ]);
    await expect(walker.tick()).resolves.toEqual([{ orgId: ORG_ID, recoveredJobIds: [], claimedJobIds: [] }]);
    expect(probe.calls() - before).toBe(1);
    const runs = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM behavior_verification_runs WHERE resolution_job_id = $1 AND stage = 'baseline'",
        ["rjob_resolution_recovery"],
      ),
    );
    expect(runs.rows[0]).toEqual({ count: "1" });
    const loop = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ state: string }>("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]),
    );
    expect(loop.rows).toEqual([{ state: "reproduced" }]);
    await expect(jobs.claimNext({ orgId: ORG_ID, leaseOwner: "negative-control" })).resolves.toBeUndefined();
  });

  it("retries repeated infrastructure failures without rejecting an already-awaiting reproduction loop", async () => {
    await owner.query("UPDATE issue_loops SET state = 'open' WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]);
    await jobs.enqueue({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      id: "rjob_resolution_infra_retry",
      issueLoopId: LOOP_ID,
      contractId,
      stage: "baseline",
      idempotencyKey: "resolution-infra-retry",
    });
    const stage = new BaselineReproductionStage({
      pool: app,
      probe: {
        async runBaseline() {
          throw new Error("probe infrastructure unavailable");
        },
      },
    });
    const walker = new ResolutionDagWalker({
      store: jobs,
      orgIds: async () => [ORG_ID],
      stages: new Map([["baseline", stage]]),
      leaseOwner: "resolution-infra-walker",
      leaseMs: 30_000,
    });

    await expect(walker.tick()).resolves.toEqual([
      { orgId: ORG_ID, recoveredJobIds: [], claimedJobIds: ["rjob_resolution_infra_retry"] },
    ]);
    await expect(walker.tick()).resolves.toEqual([
      { orgId: ORG_ID, recoveredJobIds: [], claimedJobIds: ["rjob_resolution_infra_retry"] },
    ]);

    const [job, loop, run] = await runWithOrgScope(app, ORG_ID, async (client) => {
      const rows = await Promise.all([
        client.query("SELECT state FROM resolution_jobs WHERE org_id = $1 AND id = $2", [
          ORG_ID,
          "rjob_resolution_infra_retry",
        ]),
        client.query("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]),
        client.query(
          `SELECT count(*)::text AS count, classification, status
             FROM behavior_verification_runs
            WHERE resolution_job_id = $1 AND stage = 'baseline'
            GROUP BY classification, status`,
          ["rjob_resolution_infra_retry"],
        ),
      ]);
      return rows.map((row) => row.rows[0]);
    });
    expect(job).toEqual({ state: "retryable" });
    expect(loop).toEqual({ state: "awaiting_reproduction" });
    expect(run).toEqual({ count: "1", classification: "infra_failure", status: "failed" });
  });

  it("refuses a baseline transition from a verified-closed loop through the real IssueLoopStore", async () => {
    await owner.query("UPDATE issue_loops SET state = 'verified_closed' WHERE org_id = $1 AND id = $2", [
      ORG_ID,
      LOOP_ID,
    ]);
    await jobs.enqueue({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      id: "rjob_resolution_terminal_loop",
      issueLoopId: LOOP_ID,
      contractId,
      stage: "baseline",
      idempotencyKey: "resolution-terminal-loop",
    });
    const claimed = await jobs.claimNext({ orgId: ORG_ID, leaseOwner: "terminal-loop-worker", leaseMs: 30_000 });
    if (claimed === undefined) throw new Error("expected terminal-loop fixture job to claim");

    await expect(new BaselineReproductionStage({ pool: app }).run(claimed, {})).rejects.toThrow(
      /refused reproduced transition/u,
    );
    const loop = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ state: string }>("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]),
    );
    expect(loop.rows).toEqual([{ state: "verified_closed" }]);
  });
});
