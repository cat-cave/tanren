// cspell:ignore rolsuper rolbypassrls
// rv-22 — real-Postgres proof for the runtime-verification HTTP read surface.
// Every decisive read runs as the restricted non-superuser `tanren_app` role
// (rolsuper=false AND rolbypassrls=false); the owner connection only provisions
// the DB and seeds FK prerequisites. Gated on TANREN_RLS_DB_TEST like every peer
// *.rls.integration test (runs in `smoke-rls-verification-reads`). Proves: the
// real Hono route → real DB → real response composition works, a FAILED verdict
// is surfaced AS failed (no laundering), and a cross-org read sees ZERO rows
// (org isolation at the DB, both through the route and directly through the store).

import { runWithOrgScope } from "@tanren/db";
import { migrate } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { VerificationReadStore } from "../src/engine/verification/acceptance/verificationReadStore.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createVerificationReadRoutes } from "../src/routes/runtimeVerification/reads.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_vr_a";
const ORG_B = "org_vr_b";
const PROJECT = "project_vr";
const NODE_ID = "inode_vr";
const ENV_ID = "venv_vr";
const PERSONA_REVISION = "pr_vr";
const BEHAVIOR_REVISION = "br_vr";
const RUN_PASS = "run_vr_pass";
const RUN_FAIL = "run_vr_fail";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

const ACTOR_A: ActorContext = {
  userId: "user_a",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function databaseName(): string {
  return `tanren_verification_reads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  await owner.query(
    `INSERT INTO behavior_verdicts
       (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
        required_assertion_count, executed_assertion_count, outcome, attempt_count,
        flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 1, 'stable', 'blocking', $10, $6)`,
    [org, id, PROJECT, runId, BEHAVIOR_REVISION, D, required, executed, outcome, CAS],
  );
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
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-vr')`,
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
  await seedVerdict(owner, ORG_A, "verdict_vr_pass", RUN_PASS, "passed", 12, 12);
  await seedVerdict(owner, ORG_A, "verdict_vr_fail", RUN_FAIL, "failed_product", 12, 0);
}

function appFor(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/v1/orgs", createVerificationReadRoutes({ pool }));
  return app;
}

describeDb("rv-22 runtime-verification read surface — real reads, isolation", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: VerificationReadStore;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    store = new VerificationReadStore(app);
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

  it("lists a project's runs through the real route → real DB → real response", async () => {
    const response = await appFor(app, ACTOR_A).request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/verification-runs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      runs: { runId: string; status: string; verdictCount: number; latestOutcome: string | null }[];
    };
    expect(body.version).toBe("v1");
    expect(body.runs.map((r) => r.runId).sort()).toEqual([RUN_FAIL, RUN_PASS].sort());
    const fail = body.runs.find((r) => r.runId === RUN_FAIL);
    expect(fail?.verdictCount).toBe(1);
    expect(fail?.latestOutcome).toBe("failed_product");
  });

  it("run detail surfaces the environment binding + verdicts, and a FAILED verdict AS failed", async () => {
    const response = await appFor(app, ACTOR_A).request(
      `/v1/orgs/${ORG_A}/projects/${PROJECT}/verification-runs/${RUN_FAIL}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { status: string };
      environment: { environmentId: string; lifecycleStatus: string } | null;
      verdicts: { outcome: string }[];
      proofBundleHref: string;
    };
    expect(body.environment?.environmentId).toBe(ENV_ID);
    expect(body.environment?.lifecycleStatus).toBe("ready");
    expect(body.verdicts.map((v) => v.outcome)).toEqual(["failed_product"]);
    expect(body.proofBundleHref).toContain(`/verification-runs/${RUN_FAIL}/proof-bundle`);
  });

  it("behavior verdict history exposes both runs' verdicts with the latest outcome", async () => {
    const response = await appFor(app, ACTOR_A).request(
      `/v1/orgs/${ORG_A}/projects/${PROJECT}/behaviors/${BEHAVIOR_REVISION}/verdicts`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      latestOutcome: string | null;
      verdicts: { verdict: { outcome: string } }[];
    };
    expect(body.verdicts).toHaveLength(2);
    expect(body.verdicts.map((v) => v.verdict.outcome).sort()).toEqual(["failed_product", "passed"]);
  });

  it("DECISIVE: a cross-org read sees ZERO rows — org B cannot read org A's run", async () => {
    const detail = await store.readRunDetail({ orgId: ORG_B, projectId: PROJECT }, RUN_PASS);
    expect(detail).toBeUndefined();
    const runs = await store.listRuns({ orgId: ORG_B, projectId: PROJECT });
    expect(runs).toEqual([]);
    const history = await store.readBehaviorHistory({ orgId: ORG_B, projectId: PROJECT }, BEHAVIOR_REVISION);
    expect(history.verdicts).toEqual([]);
    expect(history.latestOutcome).toBeNull();
  });
});
