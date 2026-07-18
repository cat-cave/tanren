// cspell:ignore adec iloop sfind sorigin vassert venv vrun
// Real-Postgres fail-closed proof for bh-11. It drives the production stage
// through the LIVE ResolutionDagWalker, then reads its immutable decision row.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import { buildResolutionAuthority } from "../src/engine/governance/resolutionAuthority.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { ProductionSymptomStage } from "../src/engine/verification/resolutionStages/productionSymptomStage.js";
import { PgRepairRouter } from "../src/engine/workflow/repairRouting.js";
import { createProductionVerificationRoutes } from "../src/routes/issueLoops/productionVerification.js";

const describeDb = process.env["TANREN_RLS_DB_TEST"] === "1" ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_resolution_authority";
const PROJECT_ID = "project_resolution_authority";
const LOOP_ID = "iloop_resolution_authority";
const NODE_ID = "inode_resolution_authority";
const ENVIRONMENT_ID = "venv_resolution_authority";
const RELEASE_ID = "release_resolution_authority";
const MERGE_SHA = "a".repeat(40);
const OTHER_ORG_ID = "org_resolution_authority_other";

type RetryRouteEnv = {
  Variables: {
    actor?: {
      userId: string;
      orgId: string | null;
      projectId: string | null;
      scopes: "org:admin"[];
      source: "session";
    };
  };
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function databaseName(): string {
  return `tanren_resolution_authority_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

/** The literal's property order is the sorted-key immutable contract representation. */
function contract() {
  return {
    baselineRequired: true,
    expectedCorrectedObservation: { body: { status: "fixed" }, status: 200 },
    expectedFailingObservation: { body: { status: "still_broken" }, status: 200 },
    issueLoopId: LOOP_ID,
    proofPolicy: "active_causal",
    sourceRevision: "source-revision-a",
    target: { url: "https://contract.example/symptom" },
    version: 1,
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

async function seed(owner: Pool, releaseUrl: string): Promise<{ artifactDigest: string; contractId: string }> {
  const artifactDigest = digest("authority-artifact");
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG_ID],
  );
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [OTHER_ORG_ID],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/authority.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name) VALUES ('source_authority', $1, $2, 'issues', 'source')`,
    [ORG_ID, PROJECT_ID],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint, severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, 'source_authority', 'authority-issue', 1, 'authority-fingerprint', 'high', 'verifying', 'active_causal', 1, now())`,
    [ORG_ID, LOOP_ID, PROJECT_ID],
  );
  await owner.query(
    `INSERT INTO source_findings
       (org_id, id, project_id, issue_loop_id, source_id, provider_object_id, provider_revision,
        status, title, fingerprint, observed_at)
     VALUES ($1, 'sfind_authority', $2, $3, 'source_authority', 'authority-issue', 'rev-1',
             'open', 'authority symptom', 'authority-fingerprint', now())`,
    [ORG_ID, PROJECT_ID, LOOP_ID],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, issue_loop_id, org_id, kind, title, status, agent_kind, cli)
     VALUES ('task_authority_triage', NULL, $1, $2, 'triage', 'authority triage', 'done', 'answerer', 'fixture')`,
    [LOOP_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO specs
       (spec_id, project_id, org_id, title, description, status, origin_issue_loop_id, origin_run_id)
     VALUES ('spec_authority_primary', $1, $2, 'Resolve authority symptom', 'primary fix',
             'merged', $3, 'run_authority_primary')`,
    [PROJECT_ID, ORG_ID, LOOP_ID],
  );
  await owner.query(
    `INSERT INTO spec_origins
       (org_id, project_id, id, spec_id, issue_loop_id, triage_task_id, attempt_number, role, ordinal)
     VALUES ($1, $2, 'sorigin_authority_primary', 'spec_authority_primary', $3,
             'task_authority_triage', 1, 'primary_fix', 0)`,
    [ORG_ID, PROJECT_ID, LOOP_ID],
  );
  await owner.query(
    `INSERT INTO spec_origin_findings (org_id, spec_id, source_finding_id)
     VALUES ($1, 'spec_authority_primary', 'sfind_authority')`,
    [ORG_ID],
  );
  const contractId = "contract_authority";
  await owner.query(
    `INSERT INTO symptom_contracts
       (org_id, project_id, id, issue_loop_id, schema_version, contract_json, canonical_hash,
        proof_policy, target, source_revision, state)
     VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, 'active_causal', $7::jsonb, $8, 'validated')`,
    [
      ORG_ID,
      PROJECT_ID,
      contractId,
      LOOP_ID,
      JSON.stringify(contract()),
      digest(JSON.stringify(contract())),
      JSON.stringify(contract().target),
      contract().sourceRevision,
    ],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/authority', 'merge_batch', '[]'::jsonb, 'member-authority', $4, 'tree-authority', 'ready')`,
    [NODE_ID, PROJECT_ID, ORG_ID, MERGE_SHA],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [ORG_ID, artifactDigest],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'production', 'authority-fingerprint', 'authority-lease', 'ready')`,
    [ORG_ID, ENVIRONMENT_ID, PROJECT_ID, NODE_ID, artifactDigest],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', 'authority-app', 'production', 'authority-deploy', $4, $5, NULL, $6, $7, 'live')`,
    [ORG_ID, RELEASE_ID, PROJECT_ID, MERGE_SHA, artifactDigest, NODE_ID, releaseUrl],
  );
  await seedEvidence(owner, artifactDigest, contractId);
  return { artifactDigest, contractId };
}

async function seedEvidence(owner: Pool, artifactDigest: string, contractId: string): Promise<void> {
  for (const [id, stage, classification] of [
    ["rjob_authority_baseline", "baseline", "product_failure"],
    ["rjob_authority_counterfactual", "counterfactual", "product_resolved"],
  ]) {
    await owner.query(
      `INSERT INTO resolution_jobs (org_id, project_id, id, issue_loop_id, contract_id, stage, state, idempotency_key, attempt)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $3, 1)`,
      [ORG_ID, PROJECT_ID, id, LOOP_ID, contractId, stage],
    );
    await owner.query(
      `INSERT INTO behavior_verification_runs
         (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
          runtime_behavior_context_hash, artifact_digest, status, policy, stage, resolution_job_id, classification)
       VALUES ($1, $2, $3, 'post_merge_production', $4, $5, 'tree-authority', $6, $7, $8, 'completed', $9::jsonb, $10, $11, $12)`,
      [
        ORG_ID,
        `vrun_${stage}`,
        PROJECT_ID,
        ENVIRONMENT_ID,
        MERGE_SHA,
        digest(`plan-${stage}`),
        digest(`context-${stage}`),
        artifactDigest,
        JSON.stringify({ proofPolicy: "active_causal" }),
        stage,
        id,
        classification,
      ],
    );
  }
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha, artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1, $2, 'adec_authority', $3, 'integration_node', $4, $4, $5, $6, 'member-authority', 'policy-authority', 'authorized')`,
    [ORG_ID, PROJECT_ID, NODE_ID, MERGE_SHA, artifactDigest, digest("proof-authority")],
  );
  await owner.query(
    `INSERT INTO authority_effect_intents
       (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha, expected_main_sha, idempotency_key)
     VALUES ($1, $2, 'aei_authority', 'adec_authority', $3, 'main', $4, $4, 'authority-intent')`,
    [ORG_ID, PROJECT_ID, NODE_ID, MERGE_SHA],
  );
  await owner.query(
    `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
     VALUES ($1, $2, 'alr_authority', 'aei_authority', $3, 'audit_authority')`,
    [ORG_ID, PROJECT_ID, MERGE_SHA],
  );
}

describeDb("ResolutionAuthority — real walker, immutable decisions, and RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;
  let baseUrl = "";
  let cosmeticFix = true;
  let artifactDigest = "";
  let contractId = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      const body =
        path === "/health"
          ? { status: "healthy" }
          : path === "/symptom"
            ? { status: cosmeticFix ? "still_broken" : "fixed" }
            : { status: "reachable" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("authority fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
    ({ artifactDigest, contractId } = await seed(owner, baseUrl));
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
    await closeServer(server);
  }, 30_000);

  async function walk(id: string, stage = new ProductionSymptomStage({ pool: app })): Promise<void> {
    const jobs = new ResolutionJobStore(app);
    await jobs.enqueue({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      id,
      issueLoopId: LOOP_ID,
      contractId,
      releaseInstanceId: RELEASE_ID,
      stage: "production",
      idempotencyKey: id,
    });
    const walker = new ResolutionDagWalker({
      store: jobs,
      orgIds: async () => [ORG_ID],
      stages: new Map([["production", stage]]),
      authority: buildResolutionAuthority(app),
      repairRouter: new PgRepairRouter(app),
      leaseOwner: `walker-${id}`,
    });
    await walker.tick();
  }

  async function retryVerification(id: string): Promise<Response> {
    const router = new Hono<RetryRouteEnv>();
    router.use("*", async (c, next) => {
      c.set("actor", {
        userId: "user_resolution_admin",
        orgId: ORG_ID,
        projectId: null,
        scopes: ["org:admin"],
        source: "session",
      });
      await next();
    });
    router.route(
      "/v1/orgs",
      createProductionVerificationRoutes({
        pool: app,
        jobId: () => id,
        executionLeaseOwner: () => `retry-${id}`,
      }),
    );
    return router.request(`/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/issue-loops/${LOOP_ID}/retry-verification`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractId, releaseInstanceId: RELEASE_ID, idempotencyKey: id }),
    });
  }

  it("uses tanren_app without superuser or RLS-bypass privileges", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("blocks a cosmetic production fix despite green reachability and demo checks, then authorizes a real fix", async () => {
    const [reachability, demo] = await Promise.all([fetch(baseUrl), fetch(`${baseUrl}/health`)]);
    expect(reachability.status).toBe(200);
    await expect(demo.json()).resolves.toEqual({ status: "healthy" });
    cosmeticFix = true;
    await walk("rjob_authority_cosmetic");
    cosmeticFix = false;
    await walk("rjob_authority_real_fix");

    const rows = await runWithOrgScope(app, ORG_ID, async (client) => {
      const [decisions, events, loop, outbox] = await Promise.all([
        client.query(
          `SELECT resolution_job_id, decision, decision_reasons, authority_version, contract_id,
                  release_instance_id, verification_run_id, input_snapshot_hash
             FROM resolution_decisions
            WHERE org_id = $1
            ORDER BY resolution_job_id`,
          [ORG_ID],
        ),
        client.query("SELECT event_type FROM events WHERE org_id = $1 AND event_type LIKE 'resolution.%' ORDER BY id", [
          ORG_ID,
        ]),
        client.query("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_ID, LOOP_ID]),
        client.query(
          `SELECT operation, state, resolution_decision_id
             FROM source_sync_outbox
            WHERE org_id = $1 AND issue_loop_id = $2`,
          [ORG_ID, LOOP_ID],
        ),
      ]);
      return { decisions: decisions.rows, events: events.rows, loop: loop.rows[0], outbox: outbox.rows };
    });
    expect(rows.decisions).toEqual([
      {
        resolution_job_id: "rjob_authority_cosmetic",
        decision: "blocked",
        decision_reasons: ["production symptom verification did not pass"],
        authority_version: "tanren-resolution-authority.v1",
        contract_id: contractId,
        release_instance_id: RELEASE_ID,
        verification_run_id: expect.any(String),
        input_snapshot_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      {
        resolution_job_id: "rjob_authority_real_fix",
        decision: "authorized",
        decision_reasons: [],
        authority_version: "tanren-resolution-authority.v1",
        contract_id: contractId,
        release_instance_id: RELEASE_ID,
        verification_run_id: expect.any(String),
        input_snapshot_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    ]);
    expect(rows.events).toEqual([{ event_type: "resolution.blocked" }, { event_type: "resolution.authorized" }]);
    expect(rows.loop).toEqual({ state: "verified_source_sync_pending" });
    const repairs = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query("SELECT spec_id FROM remediation_attempts WHERE org_id = $1 AND issue_loop_id = $2", [
        ORG_ID,
        LOOP_ID,
      ]),
    );
    expect(repairs.rows).toEqual([{ spec_id: expect.stringMatching(/^spec_/u) }]);
    expect(rows.outbox).toEqual([
      { operation: "close", state: "pending", resolution_decision_id: expect.stringMatching(/^rdec_/u) },
    ]);
    expect(artifactDigest).toMatch(/^sha256:/u);
  });

  it("records cosmetic and real operator retries through the same authority ledger", async () => {
    cosmeticFix = true;
    const cosmetic = await retryVerification("rjob_authority_retry_cosmetic");
    cosmeticFix = false;
    const real = await retryVerification("rjob_authority_retry_real");

    expect(cosmetic.status).toBe(200);
    expect(real.status).toBe(200);
    const rows = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query(
        `SELECT resolution_job_id, decision, authority_version, contract_id, release_instance_id, verification_run_id
           FROM resolution_decisions
          WHERE resolution_job_id IN ('rjob_authority_retry_cosmetic', 'rjob_authority_retry_real')
          ORDER BY resolution_job_id`,
      ),
    );
    expect(rows.rows).toEqual([
      {
        resolution_job_id: "rjob_authority_retry_cosmetic",
        decision: "blocked",
        authority_version: "tanren-resolution-authority.v1",
        contract_id: contractId,
        release_instance_id: RELEASE_ID,
        verification_run_id: expect.any(String),
      },
      {
        resolution_job_id: "rjob_authority_retry_real",
        decision: "authorized",
        authority_version: "tanren-resolution-authority.v1",
        contract_id: contractId,
        release_instance_id: RELEASE_ID,
        verification_run_id: expect.any(String),
      },
    ]);
  });

  it("records needs_attention for an inconclusive production probe, never authorization", async () => {
    const stage = new ProductionSymptomStage({
      pool: app,
      probe: {
        async runVerification(input) {
          return {
            orgId: input.orgId,
            projectId: input.projectId,
            issueLoopId: LOOP_ID,
            contractId: input.contractId,
            verificationRunId: input.verificationRunId,
            expectedHash: digest("expected") as Digest,
            observedHash: digest("inconclusive") as Digest,
            outcome: "inconclusive",
            timingMs: 0,
            evidence: [],
            assertionId: "vassert_inconclusive",
          };
        },
      },
    });
    await walk("rjob_authority_inconclusive", stage);
    const row = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query("SELECT decision FROM resolution_decisions WHERE resolution_job_id = $1", [
        "rjob_authority_inconclusive",
      ]),
    );
    expect(row.rows).toEqual([{ decision: "needs_attention" }]);
  });

  it("rejects UPDATE and DELETE on the append-only decision ledger", async () => {
    await expect(
      runWithOrgScope(app, ORG_ID, (client) =>
        client.query("UPDATE resolution_decisions SET decision = 'authorized' WHERE org_id = $1", [ORG_ID]),
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      runWithOrgScope(app, ORG_ID, (client) =>
        client.query("DELETE FROM resolution_decisions WHERE org_id = $1", [ORG_ID]),
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("does not expose one org's resolution decisions to another org", async () => {
    const invisible = await runWithOrgScope(app, OTHER_ORG_ID, (client) =>
      client.query("SELECT id FROM resolution_decisions WHERE org_id = $1", [ORG_ID]),
    );
    expect(invisible.rows).toEqual([]);
  });
});
