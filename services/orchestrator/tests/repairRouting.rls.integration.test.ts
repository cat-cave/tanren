// cspell:ignore iloop rdec sfind sorigin
// bh-13: real RLS proof for the callable deterministic repair route. The live
// walker composition is exercised by resolutionAuthority.rls.integration.test.

import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
     VALUES ($1, 'repair route', 'https://example.com/repair.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
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
  for (const [jobId, decisionId] of [
    ["rjob_repair_route_first", "rdec_repair_route_first"],
    ["rjob_repair_route_repeat", "rdec_repair_route_repeat"],
  ]) {
    await owner.query(
      `INSERT INTO resolution_jobs
         (org_id, project_id, id, issue_loop_id, contract_id, stage, state, idempotency_key, attempt)
       VALUES ($1, $2, $3, $4, $5, 'production', 'blocked', $3, 1)`,
      [ORG_A, PROJECT, jobId, LOOP, CONTRACT],
    );
    await owner.query(
      `INSERT INTO resolution_decisions
         (org_id, project_id, id, resolution_job_id, issue_loop_id, decision, decision_reasons,
          authority_version, contract_id, input_snapshot_hash)
       VALUES ($1, $2, $3, $4, $5, 'blocked', '["production symptom verification did not pass"]'::jsonb,
               'tanren-resolution-authority.v1', $6, $7)`,
      [ORG_A, PROJECT, decisionId, jobId, LOOP, CONTRACT, digest(decisionId)],
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
    app = new Pool({ connectionString: databaseUrl(database, true) });
    await seed(owner);
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

  it("uses tanren_app without superuser or RLS-bypass privileges", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("routes one P0 successor from a blocked decision and preserves the merged original", async () => {
    const response = await router(app).request(
      `/v1/orgs/${ORG_A}/projects/${PROJECT}/issue-loops/${LOOP}/route-repair`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolutionDecisionId: "rdec_repair_route_first" }),
      },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { repair: { specId: string; failureSignatureHash: string } };

    const rows = await runWithOrgScope(app, ORG_A, async (client) => {
      const [attempts, origin, original, successor, events] = await Promise.all([
        client.query(
          "SELECT iteration, prior_attempt_id, failure_signature, spec_id FROM remediation_attempts WHERE org_id = $1",
          [ORG_A],
        ),
        client.query("SELECT role, attempt_number FROM spec_origins WHERE org_id = $1 AND spec_id = $2", [
          ORG_A,
          body.repair.specId,
        ]),
        client.query("SELECT status FROM specs WHERE spec_id = 'spec_repair_route_primary'", []),
        client.query("SELECT status, priority, parent_spec_id, source_finding_ids FROM specs WHERE spec_id = $1", [
          body.repair.specId,
        ]),
        client.query(
          "SELECT event_type FROM events WHERE org_id = $1 AND event_type LIKE 'remediation.%' ORDER BY id",
          [ORG_A],
        ),
      ]);
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
  });

  it("is idempotent for a retried decision but parks an identical-signature recurrence", async () => {
    const route = router(app);
    const first = await route.request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/issue-loops/${LOOP}/route-repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionDecisionId: "rdec_repair_route_first" }),
    });
    expect(first.status).toBe(200);
    const repeated = await route.request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/issue-loops/${LOOP}/route-repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionDecisionId: "rdec_repair_route_repeat" }),
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      repair: { kind: "needs_attention", reason: "fixed_point" },
    });
    const rows = await runWithOrgScope(app, ORG_A, async (client) => {
      const [attempts, loop, routed] = await Promise.all([
        client.query("SELECT id FROM remediation_attempts WHERE org_id = $1", [ORG_A]),
        client.query("SELECT state FROM issue_loops WHERE org_id = $1 AND id = $2", [ORG_A, LOOP]),
        client.query("SELECT id FROM events WHERE org_id = $1 AND event_type = 'remediation.repair_routed'", [ORG_A]),
      ]);
      return { attempts: attempts.rows, loop: loop.rows, routed: routed.rows };
    });
    expect(rows.attempts).toHaveLength(1);
    expect(rows.loop).toEqual([{ state: "needs_attention" }]);
    expect(rows.routed).toHaveLength(1);
  });

  it("does not expose remediation attempts across organizations", async () => {
    const invisible = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM remediation_attempts WHERE org_id = $1", [ORG_A]),
    );
    expect(invisible.rows).toEqual([]);
  });
});
