// cspell:ignore rvgate
// rv-gate — real-Postgres proof that `resolveLandTimeBehaviorGate` reads the run's
// behavior-acceptance outcome under org scope (RLS) and classifies it fail-closed. The
// DB-less decision table is pinned in behaviorLandGate.test.ts; this proves the SQL join
// (behavior_verdicts → behavior_verification_runs, purpose = 'pre_merge', bound to the
// merge run) and the org-scoped read. Gated on TANREN_RLS_DB_TEST like every peer
// *.rls.integration test.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLandTimeBehaviorGate } from "../src/engine/merge/behaviorLandGate.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_rvgate";
const PROJECT = "project_rvgate";
const NODE_ID = "inode_rvgate";
const ENV_ID = "venv_rvgate";
const PERSONA_REVISION = "pr_rvgate";
const BEHAVIOR_REVISION = "br_rvgate";
const SPEC_ID = "spec_rvgate";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

function databaseName(): string {
  return `tanren_rvgate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 'rvgate', 'rv-gate coverage', 'in_flight')`,
    [SPEC_ID, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-rvgate')`,
    [NODE_ID, PROJECT, ORG, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
}

/** Seed a merge `runs` row (the land subject) for one scenario. */
async function seedMergeRun(owner: Pool, mergeRunId: string): Promise<void> {
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'feat', 'running')`,
    [mergeRunId, SPEC_ID, PROJECT, ORG],
  );
}

/** Seed a pre-merge behavior verification run bound to `mergeRunId`, returning its id. */
async function seedPreMergeVerification(
  app: Pool,
  mergeRunId: string,
  status: "running" | "completed",
): Promise<string> {
  const id = `bvr_${mergeRunId}`;
  await runWithOrgScope(app, ORG, (client) =>
    client.query(
      `INSERT INTO behavior_verification_runs
         (org_id, id, project_id, purpose, run_id, spec_id, integration_node_id, environment_id,
          prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
       VALUES ($1, $2, $3, 'pre_merge', $4, $5, $6, $7, $8, $8, $8, $8, $9, $10, '{}'::jsonb)`,
      [ORG, id, PROJECT, mergeRunId, SPEC_ID, NODE_ID, ENV_ID, D, CAS, status],
    ),
  );
  return id;
}

async function seedVerdict(
  app: Pool,
  verificationRunId: string,
  verdictId: string,
  fields: {
    outcome: string;
    gateEffect: "blocking" | "advisory";
    flakeState?: "stable" | "quarantined_fragment";
    required?: number;
    executed?: number;
  },
): Promise<void> {
  const required = fields.required ?? (fields.outcome === "passed" ? 1 : 0);
  const executed = fields.executed ?? (fields.outcome === "passed" ? 1 : 0);
  await runWithOrgScope(app, ORG, (client) =>
    client.query(
      `INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 1, $10, $11, $12, $6)`,
      [
        ORG,
        verdictId,
        PROJECT,
        verificationRunId,
        BEHAVIOR_REVISION,
        digest(verdictId),
        required,
        executed,
        fields.outcome,
        fields.flakeState ?? "stable",
        fields.gateEffect,
        CAS,
      ],
    ),
  );
}

describeDb("resolveLandTimeBehaviorGate — org-scoped land-time read", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
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

  it("no pre-merge verification for the run → not_applicable (never blocks a non-behavior run)", async () => {
    await seedMergeRun(owner, "run_none");
    expect(await resolveLandTimeBehaviorGate(app, ORG, "run_none")).toEqual({ kind: "not_applicable" });
  });

  it("all blocking behaviors passed → passed", async () => {
    await seedMergeRun(owner, "run_pass");
    const bvr = await seedPreMergeVerification(app, "run_pass", "completed");
    await seedVerdict(app, bvr, "v_pass_1", { outcome: "passed", gateEffect: "blocking" });
    expect(await resolveLandTimeBehaviorGate(app, ORG, "run_pass")).toEqual({
      kind: "passed",
      passedBlockingCount: 1,
    });
  });

  it("a blocking failed_product verdict → failed (fail closed)", async () => {
    await seedMergeRun(owner, "run_fail");
    const bvr = await seedPreMergeVerification(app, "run_fail", "completed");
    await seedVerdict(app, bvr, "v_fail_1", { outcome: "failed_product", gateEffect: "blocking" });
    const gate = await resolveLandTimeBehaviorGate(app, ORG, "run_fail");
    expect(gate).toMatchObject({ kind: "failed", outcome: "failed_product" });
  });

  it("a still-running pre-merge verification → inconclusive (required-but-not-decided)", async () => {
    await seedMergeRun(owner, "run_running");
    await seedPreMergeVerification(app, "run_running", "running");
    expect((await resolveLandTimeBehaviorGate(app, ORG, "run_running")).kind).toBe("inconclusive");
  });

  it("a quarantined failing verdict is excluded-from-green — a co-passing blocking verdict still passes", async () => {
    await seedMergeRun(owner, "run_quarantine");
    const bvr = await seedPreMergeVerification(app, "run_quarantine", "completed");
    await seedVerdict(app, bvr, "v_q_pass", { outcome: "passed", gateEffect: "blocking" });
    await seedVerdict(app, bvr, "v_q_flaky", {
      outcome: "failed_product",
      gateEffect: "blocking",
      flakeState: "quarantined_fragment",
    });
    expect(await resolveLandTimeBehaviorGate(app, ORG, "run_quarantine")).toEqual({
      kind: "passed",
      passedBlockingCount: 1,
    });
  });

  it("an ADVISORY failing verdict never gates → not_applicable", async () => {
    await seedMergeRun(owner, "run_advisory");
    const bvr = await seedPreMergeVerification(app, "run_advisory", "completed");
    await seedVerdict(app, bvr, "v_adv", { outcome: "failed_product", gateEffect: "advisory" });
    expect(await resolveLandTimeBehaviorGate(app, ORG, "run_advisory")).toEqual({ kind: "not_applicable" });
  });

  it("the read is org-scoped — a foreign org sees no verdicts (not_applicable)", async () => {
    await seedMergeRun(owner, "run_scope");
    const bvr = await seedPreMergeVerification(app, "run_scope", "completed");
    await seedVerdict(app, bvr, "v_scope", { outcome: "failed_product", gateEffect: "blocking" });
    // Under the OWNING org the failure gates; under a different org RLS hides the rows so
    // the reader sees no pre-merge run at all → not_applicable (RLS denies by default).
    expect((await resolveLandTimeBehaviorGate(app, ORG, "run_scope")).kind).toBe("failed");
    expect(await resolveLandTimeBehaviorGate(app, "org_other", "run_scope")).toEqual({ kind: "not_applicable" });
  });
});
