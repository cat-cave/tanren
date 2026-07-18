// cspell:ignore iloop rdec sfind sorigin vassert
// bh-13: real RLS proof for the callable deterministic repair route. The live
// walker composition is exercised by resolutionAuthority.rls.integration.test.

import { DAG_CHANGE_CHANNEL, migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDagWalker } from "../src/engine/dag/walker.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIssueLoopCommandRoutes } from "../src/routes/issueLoops/commands.js";

const describeDb = process.env["TANREN_RLS_DB_TEST"] === "1" ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_repair_route_a";
const ORG_B = "org_repair_route_b";
const PROJECT = "project_repair_route";
const LOOP = "iloop_repair_route";
const CONTRACT = "contract_repair_route";
const NODE = "inode_repair_route";
const ENVIRONMENT = "venv_repair_route";
const ARTIFACT = digest("repair route artifact");

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function databaseName(): string {
  return `tanren_repair_routing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seed(owner: Pool): Promise<void> {
  for (const orgId of [ORG_A, ORG_B]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [orgId],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'repair route', 'https://example.com/repair.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
    [PROJECT, ORG_A],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ('source_repair_route', $1, $2, 'issues', 'repair source')`,
    [ORG_A, PROJECT],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint, severity,
        state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, 'source_repair_route', 'repair-1', 1, 'repair-fingerprint', 'high',
             'remediating', 'active_causal', 1, now())`,
    [ORG_A, LOOP, PROJECT],
  );
  await owner.query(
    `INSERT INTO source_findings
       (org_id, id, project_id, issue_loop_id, source_id, provider_object_id, provider_revision,
        status, title, fingerprint, observed_at)
     VALUES ($1, 'sfind_repair_route', $2, $3, 'source_repair_route', 'repair-1', 'revision-1',
             'open', 'repair symptom', 'repair-fingerprint', now())`,
    [ORG_A, PROJECT, LOOP],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, issue_loop_id, org_id, kind, title, status, agent_kind, cli)
     VALUES ('task_repair_route_triage', NULL, $1, $2, 'triage', 'repair triage', 'done', 'answerer', 'fixture')`,
    [LOOP, ORG_A],
  );
  await owner.query(
    `INSERT INTO specs
       (spec_id, project_id, org_id, title, description, status, origin_issue_loop_id, origin_run_id)
     VALUES ('spec_repair_route_primary', $1, $2, 'Resolve repair symptom', 'primary fix',
             'merged', $3, 'run_repair_route_primary')`,
    [PROJECT, ORG_A, LOOP],
  );
  await owner.query(
    `INSERT INTO spec_origins
       (org_id, project_id, id, spec_id, issue_loop_id, triage_task_id, attempt_number, role, ordinal)
     VALUES ($1, $2, 'sorigin_repair_route_primary', 'spec_repair_route_primary', $3,
             'task_repair_route_triage', 1, 'primary_fix', 0)`,
    [ORG_A, PROJECT, LOOP],
  );
  await owner.query(
    `INSERT INTO spec_origin_findings (org_id, spec_id, source_finding_id)
     VALUES ($1, 'spec_repair_route_primary', 'sfind_repair_route')`,
    [ORG_A],
  );
  await owner.query(
    `INSERT INTO symptom_contracts
       (org_id, project_id, id, issue_loop_id, schema_version, contract_json, canonical_hash,
        proof_policy, target, source_revision, state)
     VALUES ($1, $2, $3, $4, 1, '{}'::jsonb, $5, 'active_causal', '{}'::jsonb, 'revision-1', 'validated')`,
    [ORG_A, PROJECT, CONTRACT, LOOP, digest("repair contract")],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/repair-route', 'merge_batch', '[]'::jsonb,
             'repair-route-member', $4, 'repair-route-tree', 'ready')`,
    [NODE, PROJECT, ORG_A, "a".repeat(40)],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [ORG_A, ARTIFACT],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'production', 'repair-route-env', 'repair-route-lease', 'ready')`,
    [ORG_A, ENVIRONMENT, PROJECT, NODE, ARTIFACT],
  );
  for (const [jobId, decisionId, verificationRunId, observedStatus, createdAt] of [
    [
      "rjob_repair_route_first",
      "rdec_repair_route_first",
      "vrun_repair_route_first",
      "still_broken",
      "2026-01-01T00:00:00.000Z",
    ],
    [
      "rjob_repair_route_repeat",
      "rdec_repair_route_repeat",
      "vrun_repair_route_repeat",
      "still_broken",
      "2026-02-02T03:04:05.000Z",
    ],
    [
      "rjob_repair_route_distinct",
      "rdec_repair_route_distinct",
      "vrun_repair_route_distinct",
      "different_broken_shape",
      "2026-03-03T04:05:06.000Z",
    ],
  ] as const) {
    await owner.query(
      `INSERT INTO resolution_jobs
         (org_id, project_id, id, issue_loop_id, contract_id, stage, state, idempotency_key, attempt)
       VALUES ($1, $2, $3, $4, $5, 'production', 'blocked', $3, 1)`,
      [ORG_A, PROJECT, jobId, LOOP, CONTRACT],
    );
    await owner.query(
      `INSERT INTO behavior_verification_runs
         (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
          runtime_behavior_context_hash, artifact_digest, status, policy, stage, resolution_job_id, classification, created_at)
       VALUES ($1, $2, $3, 'post_merge_production', $4, $5, 'repair-route-tree', $6, $7, $8,
               'completed', '{"proofPolicy":"active_causal"}'::jsonb, 'production', $9, 'product_failure', $10)`,
      [
        ORG_A,
        verificationRunId,
        PROJECT,
        ENVIRONMENT,
        "a".repeat(40),
        digest(`plan:${verificationRunId}`),
        digest(`context:${verificationRunId}`),
        ARTIFACT,
        jobId,
        createdAt,
      ],
    );
    await owner.query(
      `INSERT INTO verification_assertions
         (org_id, id, verification_run_id, expected_hash, observed_hash, outcome, timing_ms, sample_data, created_at)
       VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7::jsonb, $8)`,
      [
        ORG_A,
        `vassert_${verificationRunId}`,
        verificationRunId,
        digest("expected corrected symptom"),
        digest(`raw observed ${verificationRunId}`),
        verificationRunId === "vrun_repair_route_first" ? 17 : 91,
        JSON.stringify({
          expectedObservation: { body: { status: "fixed" }, status: 200 },
          observedObservation: {
            body: { status: observedStatus },
            counter: verificationRunId === "vrun_repair_route_first" ? 1 : 44,
            probeId: `probe_${verificationRunId}`,
            timestamp: createdAt,
            verificationRunId,
            status: 200,
          },
        }),
        createdAt,
      ],
    );
    await owner.query(
      `INSERT INTO resolution_decisions
         (org_id, project_id, id, resolution_job_id, issue_loop_id, decision, decision_reasons,
          authority_version, contract_id, verification_run_id, input_snapshot_hash)
       VALUES ($1, $2, $3, $4, $5, 'blocked', '["production symptom verification did not pass"]'::jsonb,
               'tanren-resolution-authority.v1', $6, $7, $8)`,
      [ORG_A, PROJECT, decisionId, jobId, LOOP, CONTRACT, verificationRunId, digest(decisionId)],
    );
  }
  for (const decision of ["authorized", "waived"] as const) {
    const jobId = `rjob_repair_route_${decision}`;
    await owner.query(
      `INSERT INTO resolution_jobs
         (org_id, project_id, id, issue_loop_id, contract_id, stage, state, idempotency_key, attempt)
       VALUES ($1, $2, $3, $4, $5, 'production', 'completed', $3, 1)`,
      [ORG_A, PROJECT, jobId, LOOP, CONTRACT],
    );
    await owner.query(
      `INSERT INTO resolution_decisions
         (org_id, project_id, id, resolution_job_id, issue_loop_id, decision, decision_reasons,
          authority_version, contract_id, input_snapshot_hash)
       VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'tanren-resolution-authority.v1', $7, $8)`,
      [ORG_A, PROJECT, `rdec_repair_route_${decision}`, jobId, LOOP, decision, CONTRACT, digest(decision)],
    );
  }
}

function router(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      userId: "user_repair_admin",
      orgId: ORG_A,
      projectId: null,
      scopes: ["org:admin"],
      source: "session",
    });
    await next();
  });
  app.route("/v1/orgs", createIssueLoopCommandRoutes({ pool }));
  return app;
}

function routeRepair(pool: Pool, resolutionDecisionId: string): Promise<Response> {
  return router(pool).request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/issue-loops/${LOOP}/route-repair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolutionDecisionId }),
  });
}

describeDb("P0 repair routing — RLS, exact lineage, and fixed point", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    setSystemPool(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
    await seed(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    resetSystemPool();
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

  it("fails closed for authorized and waived route requests without creating attempts", async () => {
    for (const decision of ["authorized", "waived"]) {
      expect((await routeRepair(app, `rdec_repair_route_${decision}`)).status).toBe(409);
    }
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query("SELECT id FROM remediation_attempts WHERE org_id = $1 AND issue_loop_id = $2", [ORG_A, LOOP]),
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("routes a P0 repair, preserves its merged parent, wakes the DagWalker, and enqueues its run", async () => {
    const listener = await app.connect();
    let resolveWake!: (payload: string) => void;
    const dagWake = new Promise<string>((resolve) => {
      resolveWake = resolve;
    });
    const onNotification = (notification: { channel: string; payload?: string }) => {
      if (notification.channel === DAG_CHANGE_CHANNEL) resolveWake(notification.payload ?? "");
    };
    listener.on("notification", onNotification);
    await listener.query(`LISTEN ${DAG_CHANGE_CHANNEL}`);
    const response = await routeRepair(app, "rdec_repair_route_first");
    const notified = await dagWake;
    await listener.query(`UNLISTEN ${DAG_CHANGE_CHANNEL}`);
    listener.off("notification", onNotification);
    listener.release();
    expect(response.status).toBe(202);
    const body = (await response.json()) as { repair: { specId: string; failureSignatureHash: string } };
    expect(notified).toBe(PROJECT);

    const rows = await runWithOrgScope(app, ORG_A, async (client) => {
      const attempts = await client.query(
        "SELECT iteration, prior_attempt_id, failure_signature, spec_id FROM remediation_attempts WHERE org_id = $1",
        [ORG_A],
      );
      const origin = await client.query(
        "SELECT role, attempt_number FROM spec_origins WHERE org_id = $1 AND spec_id = $2",
        [ORG_A, body.repair.specId],
      );
      const original = await client.query("SELECT status FROM specs WHERE spec_id = 'spec_repair_route_primary'");
      const successor = await client.query(
        "SELECT status, priority, parent_spec_id, source_finding_ids FROM specs WHERE spec_id = $1",
        [body.repair.specId],
      );
      const events = await client.query(
        "SELECT event_type FROM events WHERE org_id = $1 AND event_type LIKE 'remediation.%' ORDER BY id",
        [ORG_A],
      );
      return {
        attempts: attempts.rows,
        origin: origin.rows,
        original: original.rows,
        successor: successor.rows,
        events: events.rows,
      };
    });
    expect(rows.attempts).toEqual([
      {
        iteration: 1,
        prior_attempt_id: null,
        failure_signature: body.repair.failureSignatureHash,
        spec_id: body.repair.specId,
      },
    ]);
    expect(rows.origin).toEqual([{ role: "repair", attempt_number: 1 }]);
    expect(rows.original).toEqual([{ status: "merged" }]);
    expect(rows.successor).toEqual([
      {
        status: "open",
        priority: "P0",
        parent_spec_id: "spec_repair_route_primary",
        source_finding_ids: ["sfind_repair_route"],
      },
    ]);
    expect(rows.events).toEqual([
      { event_type: "remediation.attempt.started" },
      { event_type: "remediation.repair_routed" },
    ]);

    const walked = await buildDagWalker(app, {}).walk(PROJECT);
    expect(walked.status).toBe("enqueued");
    expect(walked.enqueuedSpecIds).toEqual([body.repair.specId]);
    expect(walked.enqueuedRunIds).toHaveLength(1);
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query("SELECT spec_id FROM runs WHERE org_id = $1 AND run_id = $2", [ORG_A, walked.enqueuedRunIds[0]]),
      ),
    ).resolves.toMatchObject({ rows: [{ spec_id: body.repair.specId }] });
  });

  it("rejects UPDATE and DELETE on the append-only remediation-attempt record", async () => {
    const attempt = await runWithOrgScope(app, ORG_A, (client) =>
      client.query<{ id: string }>("SELECT id FROM remediation_attempts WHERE org_id = $1", [ORG_A]),
    );
    const id = attempt.rows[0]?.id;
    if (id === undefined) throw new Error("repair route test did not create an attempt");
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query("UPDATE remediation_attempts SET hypothesis = 'rewrite' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      runWithOrgScope(app, ORG_A, (client) => client.query("DELETE FROM remediation_attempts WHERE id = $1", [id])),
    ).rejects.toThrow(/immutable/u);
  });

  it("reaches the fixed point across noisy cosmetic verification replays", async () => {
    const first = await routeRepair(app, "rdec_repair_route_first");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { repair: { failureSignatureHash: string } };
    const repeated = await routeRepair(app, "rdec_repair_route_repeat");
    expect(repeated.status).toBe(200);
    const repeatedBody = (await repeated.json()) as {
      repair: { kind: string; reason: string; failureSignatureHash: string };
    };
    expect(repeatedBody.repair).toMatchObject({ kind: "needs_attention", reason: "fixed_point" });
    expect(repeatedBody.repair.failureSignatureHash).toBe(firstBody.repair.failureSignatureHash);
    const rows = await runWithOrgScope(app, ORG_A, async (client) => {
      const attempts = await client.query("SELECT id FROM remediation_attempts WHERE org_id = $1", [ORG_A]);
      const loop = await client.query("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_A, LOOP]);
      const routed = await client.query(
        "SELECT id FROM events WHERE org_id = $1 AND event_type = 'remediation.repair_routed'",
        [ORG_A],
      );
      const evidence = await client.query<{ verification_run_id: string; observed_hash: string; created_at: string }>(
        `SELECT assertion.verification_run_id, assertion.observed_hash, assertion.created_at::text
           FROM verification_assertions AS assertion
           WHERE assertion.org_id = $1 AND assertion.verification_run_id = ANY($2::text[])
           ORDER BY assertion.verification_run_id`,
        [ORG_A, ["vrun_repair_route_first", "vrun_repair_route_repeat"]],
      );
      return { attempts: attempts.rows, loop: loop.rows, routed: routed.rows, evidence: evidence.rows };
    });
    expect(rows.attempts).toHaveLength(1);
    expect(rows.loop).toEqual([{ state: "needs_attention" }]);
    expect(rows.routed).toHaveLength(1);
    expect(rows.evidence.map((row) => row.verification_run_id)).toEqual([
      "vrun_repair_route_first",
      "vrun_repair_route_repeat",
    ]);
    expect(rows.evidence[0]?.observed_hash).not.toBe(rows.evidence[1]?.observed_hash);
    expect(rows.evidence[0]?.created_at).not.toBe(rows.evidence[1]?.created_at);
  });

  it("links a distinct failure to its prior repair attempt with a new hypothesis", async () => {
    const first = await runWithOrgScope(app, ORG_A, (client) =>
      client.query<{ id: string; spec_id: string; failure_signature: string }>(
        "SELECT id, spec_id, failure_signature FROM remediation_attempts WHERE org_id = $1",
        [ORG_A],
      ),
    );
    const firstAttempt = first.rows[0];
    if (firstAttempt === undefined) throw new Error("fixed-point test did not retain the first attempt");
    await runWithOrgScope(app, ORG_A, (client) =>
      client.query("UPDATE specs SET status = 'merged' WHERE org_id = $1 AND spec_id = $2", [
        ORG_A,
        firstAttempt.spec_id,
      ]),
    );
    const response = await routeRepair(app, "rdec_repair_route_distinct");
    expect(response.status).toBe(202);
    const body = (await response.json()) as { repair: { specId: string; failureSignatureHash: string } };
    expect(body.repair.failureSignatureHash).not.toBe(firstAttempt.failure_signature);
    const rows = await runWithOrgScope(app, ORG_A, async (client) => {
      const attempts = await client.query<{
        id: string;
        iteration: number;
        prior_attempt_id: string | null;
        hypothesis: string;
        failure_signature: string;
      }>(
        `SELECT id, iteration, prior_attempt_id, hypothesis, failure_signature
           FROM remediation_attempts WHERE org_id = $1 ORDER BY iteration`,
        [ORG_A],
      );
      const successor = await client.query("SELECT parent_spec_id FROM specs WHERE org_id = $1 AND spec_id = $2", [
        ORG_A,
        body.repair.specId,
      ]);
      const origin = await client.query(
        "SELECT role, attempt_number FROM spec_origins WHERE org_id = $1 AND spec_id = $2",
        [ORG_A, body.repair.specId],
      );
      return { attempts: attempts.rows, successor: successor.rows, origin: origin.rows };
    });
    expect(rows.attempts).toHaveLength(2);
    expect(rows.attempts[1]).toMatchObject({
      iteration: 2,
      prior_attempt_id: firstAttempt.id,
      failure_signature: body.repair.failureSignatureHash,
    });
    expect(rows.attempts[1]?.hypothesis).toContain("rdec_repair_route_distinct");
    expect(rows.successor).toEqual([{ parent_spec_id: firstAttempt.spec_id }]);
    expect(rows.origin).toEqual([{ role: "repair", attempt_number: 2 }]);
  });

  it("does not expose remediation attempts across organizations", async () => {
    const invisible = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM remediation_attempts WHERE org_id = $1", [ORG_A]),
    );
    expect(invisible.rows).toEqual([]);
  });
});
