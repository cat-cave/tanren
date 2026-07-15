// Real-Postgres / RLS integration proof for the production recovery ownership chain:
//   DirectRunStateWriter.prepareSpecForRecovery → createQueuedRun → PgRecoveryEvidencePort.verifyOwnedReceipt
//
// Proves under the REAL migration policies (tanren_app NOBYPASSRLS + tanren_system BYPASSRLS):
//   (1) allowlisted prepare under org A reopens to open + steering, then createQueuedRun
//       yields a queued run + planner task; system-scope evidence port proves that receipt
//   (2) wrong-org prepare sees zero rows → missing, zero writes
//   (3) halted run fails evidence readback (undefined)
//   (4) wrong plannerTaskId / wrong expectedSpecId fail evidence readback
//   (5) unscoped app-pool SELECT on runs sees zero rows while system-scope evidence still reads
//
// Gated: TANREN_RLS_DB_TEST=1 + owner DATABASE_URL (same as other RLS cohorts).
// Live recipe: `just smoke-rls-recovery-evidence`

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSystemPool, setSystemPool } from "@tanren/db";
import { PgRecoveryEvidencePort } from "../src/engine/merge/recoveryEvidencePg.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_rls_recovery_ev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_recovery_a";
const ORG_B = "org_recovery_b";
const PROJECT_A = `proj_${ORG_A}`;
const SPEC_A = `spec_${ORG_A}`;
const SPEC_B = `spec_${ORG_B}`;

const ACTOR_A = {
  userId: "user_recovery_a",
  orgId: ORG_A,
  projectId: PROJECT_A,
  scopes: ["platform:admin"] as string[],
  source: "local_dev" as const,
};

describeDb("RLS recovery evidence — prepare + createQueuedRun + PgRecoveryEvidencePort", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });
    setSystemPool(systemPool);

    await seedOrgProjectSpec(ownerPool, ORG_A, PROJECT_A, SPEC_A, "in_flight");
    await seedOrgProjectSpec(ownerPool, ORG_B, `proj_${ORG_B}`, SPEC_B, "in_flight");
  }, 90_000);

  afterAll(async () => {
    setSystemPool(undefined);
    resetSystemPool();
    await appPool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("prepare under org A + createQueuedRun; system-scope evidence proves the new owner run+task", async () => {
    const writer = new DirectRunStateWriter(appPool);
    const prep = await writer.prepareSpecForRecovery({
      specId: SPEC_A,
      orgId: ORG_A,
      steeringNote: "replan after conflict",
    });
    expect(prep).toEqual({ prepared: true, fromStatus: "in_flight" });

    // Prepare SQL runs under runWithOrgScope: status is open, steering present (owner-visible).
    const afterPrep = await ownerPool.query<{ status: string; description: string }>(
      "SELECT status, description FROM specs WHERE spec_id = $1",
      [SPEC_A],
    );
    expect(afterPrep.rows[0]?.status).toBe("open");
    expect(afterPrep.rows[0]?.description).toContain("replan after conflict");

    const run = await writer.createQueuedRun({
      input: { specId: SPEC_A, trigger: "replan_routed" },
      actor: ACTOR_A,
    });
    expect(run.runId).toMatch(/^run_/u);
    expect(run.plannerTaskId).toMatch(/^task_/u);

    // Unscoped app-pool SELECT sees zero rows (deny-by-default RLS).
    const unscoped = await appPool.query("SELECT run_id, status FROM runs WHERE run_id = $1", [run.runId]);
    expect(unscoped.rowCount).toBe(0);

    // Intentional system-scope evidence port re-reads the active owner.
    const evidence = new PgRecoveryEvidencePort(appPool);
    const proved = await evidence.verifyOwnedReceipt({
      expectedSpecId: SPEC_A,
      receipt: {
        kind: "planner_replan",
        specId: SPEC_A,
        run: { kind: "enqueued", replanRunId: run.runId, plannerTaskId: run.plannerTaskId },
      },
    });
    expect(proved).toEqual({
      runId: run.runId,
      specId: SPEC_A,
      runStatus: "queued",
      plannerTaskId: run.plannerTaskId,
    });
  });

  it("wrong-org prepare: missing row, zero writes on org A spec", async () => {
    // Reset SPEC_B to in_flight under owner; wrong-org prepare must not touch SPEC_A.
    await ownerPool.query(`UPDATE specs SET status = 'in_flight', description = 'd' WHERE spec_id = $1`, [SPEC_A]);
    const before = await ownerPool.query<{ status: string; description: string }>(
      "SELECT status, description FROM specs WHERE spec_id = $1",
      [SPEC_A],
    );
    const writer = new DirectRunStateWriter(appPool);
    const prep = await writer.prepareSpecForRecovery({
      specId: SPEC_A,
      orgId: ORG_B,
      steeringNote: "should not stick",
    });
    expect(prep).toEqual({ prepared: false, reason: "missing" });
    const after = await ownerPool.query<{ status: string; description: string }>(
      "SELECT status, description FROM specs WHERE spec_id = $1",
      [SPEC_A],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("halted run: evidence port returns undefined", async () => {
    const writer = new DirectRunStateWriter(appPool);
    await ownerPool.query(`UPDATE specs SET status = 'open' WHERE spec_id = $1`, [SPEC_A]);
    const run = await writer.createQueuedRun({
      input: { specId: SPEC_A, trigger: "replan_routed" },
      actor: ACTOR_A,
    });
    await ownerPool.query(`UPDATE runs SET status = 'halted' WHERE run_id = $1`, [run.runId]);
    const evidence = new PgRecoveryEvidencePort(appPool);
    const proved = await evidence.verifyOwnedReceipt({
      expectedSpecId: SPEC_A,
      receipt: {
        kind: "planner_replan",
        specId: SPEC_A,
        run: { kind: "enqueued", replanRunId: run.runId, plannerTaskId: run.plannerTaskId },
      },
    });
    expect(proved).toBeUndefined();
  });

  it("wrong plannerTaskId: evidence port returns undefined", async () => {
    const writer = new DirectRunStateWriter(appPool);
    await ownerPool.query(`UPDATE specs SET status = 'open' WHERE spec_id = $1`, [SPEC_A]);
    const run = await writer.createQueuedRun({
      input: { specId: SPEC_A, trigger: "replan_routed" },
      actor: ACTOR_A,
    });
    const evidence = new PgRecoveryEvidencePort(appPool);
    const proved = await evidence.verifyOwnedReceipt({
      expectedSpecId: SPEC_A,
      receipt: {
        kind: "planner_replan",
        specId: SPEC_A,
        run: { kind: "enqueued", replanRunId: run.runId, plannerTaskId: "task_forged_other" },
      },
    });
    expect(proved).toBeUndefined();
  });

  it("non-plan task on the same run cannot satisfy plannerTaskId", async () => {
    // Enqueued proof binds task id + run id + kind='plan'. A write task on the
    // same run must not pass as the planner task.
    const writer = new DirectRunStateWriter(appPool);
    await ownerPool.query(`UPDATE specs SET status = 'open' WHERE spec_id = $1`, [SPEC_A]);
    const run = await writer.createQueuedRun({
      input: { specId: SPEC_A, trigger: "replan_routed" },
      actor: ACTOR_A,
    });
    const writeTaskId = `task_write_${Date.now()}`;
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'write', 'Write', 'queued', 'writer', 'fake', 'm')`,
      [writeTaskId, run.runId, ORG_A],
    );
    const evidence = new PgRecoveryEvidencePort(appPool);
    const forged = await evidence.verifyOwnedReceipt({
      expectedSpecId: SPEC_A,
      receipt: {
        kind: "planner_replan",
        specId: SPEC_A,
        run: { kind: "enqueued", replanRunId: run.runId, plannerTaskId: writeTaskId },
      },
    });
    expect(forged).toBeUndefined();
    // Positive control: the real plan task still proves.
    const real = await evidence.verifyOwnedReceipt({
      expectedSpecId: SPEC_A,
      receipt: {
        kind: "planner_replan",
        specId: SPEC_A,
        run: { kind: "enqueued", replanRunId: run.runId, plannerTaskId: run.plannerTaskId },
      },
    });
    expect(real?.plannerTaskId).toBe(run.plannerTaskId);
  });

  it("wrong expectedSpecId: evidence port returns undefined", async () => {
    const writer = new DirectRunStateWriter(appPool);
    await ownerPool.query(`UPDATE specs SET status = 'open' WHERE spec_id = $1`, [SPEC_A]);
    const run = await writer.createQueuedRun({
      input: { specId: SPEC_A, trigger: "replan_routed" },
      actor: ACTOR_A,
    });
    const evidence = new PgRecoveryEvidencePort(appPool);
    const proved = await evidence.verifyOwnedReceipt({
      expectedSpecId: SPEC_B,
      receipt: {
        kind: "planner_replan",
        // Forged receipt claims the wrong spec while naming org-A's run ids.
        specId: SPEC_B,
        run: { kind: "enqueued", replanRunId: run.runId, plannerTaskId: run.plannerTaskId },
      },
    });
    expect(proved).toBeUndefined();
  });
});

async function seedOrgProjectSpec(
  owner: Pool,
  orgId: string,
  projectId: string,
  specId: string,
  status: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', $4)`,
    [specId, projectId, orgId, status],
  );
}
