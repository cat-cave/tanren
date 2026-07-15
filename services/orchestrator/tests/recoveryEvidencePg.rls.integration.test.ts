// Real-Postgres/RLS proof for PgRecoveryEvidencePort — the production settlement
// ownership readback. Pins: correct-org active owner + plan task; wrong-org
// rejection; inactive/halted owner; non-plan task; structural mismatch. Gated on
// TANREN_RLS_DB_TEST=1 like the recovery-park cohort.

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSystemPool } from "@tanren/db";
import type { ConflictRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import { PgRecoveryEvidencePort } from "../src/engine/merge/recoveryEvidencePg.js";
import { createWriteEndpointHarness, enabled, ORG, PROJECT, seedRun, SPEC } from "./planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

const OTHER_ORG = "org_p3_rw_other";
const OTHER_SPEC = "spec_p3_rw_other";

function enqueued(specId: string, runId: string, taskId: string): ConflictRecoveryReceipt {
  return {
    kind: "planner_replan",
    specId,
    run: { kind: "enqueued", replanRunId: runId, plannerTaskId: taskId },
  };
}

function alreadyRunning(specId: string, runId: string): ConflictRecoveryReceipt {
  return {
    kind: "planner_replan",
    specId,
    run: { kind: "already_running", runId },
  };
}

async function seedExtraRun(
  owner: Pool,
  opts: {
    runId: string;
    orgId?: string;
    specId?: string;
    status?: string;
    taskId?: string;
    taskKind?: string;
  },
): Promise<void> {
  const orgId = opts.orgId ?? ORG;
  const specId = opts.specId ?? SPEC;
  const status = opts.status ?? "running";
  if (orgId !== ORG) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [orgId],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'p', 'https://example.com/r.git', $2) ON CONFLICT (project_id) DO NOTHING`,
      [`proj_${orgId}`, orgId],
    );
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 't', 'd', 'in_flight') ON CONFLICT (spec_id) DO NOTHING`,
      [specId, `proj_${orgId}`, orgId],
    );
  }
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', $5)
     ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, spec_id = EXCLUDED.spec_id`,
    [opts.runId, specId, orgId === ORG ? PROJECT : `proj_${orgId}`, orgId, status],
  );
  if (opts.taskId !== undefined) {
    await owner.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, $4, 't', 'running', 'answerer', 'fake', 'm')
       ON CONFLICT (task_id) DO UPDATE SET kind = EXCLUDED.kind, run_id = EXCLUDED.run_id`,
      [opts.taskId, opts.runId, orgId, opts.taskKind ?? "plan"],
    );
  }
}

describeDb("PgRecoveryEvidencePort — real PG ownership/RLS negatives", () => {
  const harness = createWriteEndpointHarness();
  const owner = () => harness.ownerPool();

  beforeAll(async () => {
    await harness.setUp();
    // Evidence port reads under system/BYPASSRLS; owner pool sees all seeded rows.
    setSystemPool(owner());
  }, 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  it("accepts a correct-org active enqueued owner with a plan task", async () => {
    const runId = "run_evidence_ok";
    const taskId = "task_evidence_ok";
    await seedRun(owner(), runId, "running");
    await owner().query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan', 'running', 'answerer', 'fake', 'm')
       ON CONFLICT (task_id) DO NOTHING`,
      [taskId, runId, ORG],
    );
    // seedRun inserts PLAN_TASK on the same run — re-point our dedicated task.
    await owner().query(`UPDATE tasks SET run_id = $1 WHERE task_id = $2`, [runId, taskId]);

    const port = new PgRecoveryEvidencePort(owner());
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: SPEC,
      receipt: enqueued(SPEC, runId, taskId),
    });
    expect(evidence).toMatchObject({ runId, specId: SPEC, runStatus: "running", plannerTaskId: taskId });
  });

  it("accepts already_running when the named run is active for the expected spec", async () => {
    const runId = "run_evidence_already";
    await seedRun(owner(), runId, "queued");
    const port = new PgRecoveryEvidencePort(owner());
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: SPEC,
      receipt: alreadyRunning(SPEC, runId),
    });
    expect(evidence).toMatchObject({ runId, specId: SPEC, runStatus: "queued" });
  });

  it("rejects wrong-spec and wrong-org runs (fail closed)", async () => {
    const runId = "run_evidence_wrong_org";
    await seedExtraRun(owner(), {
      runId,
      orgId: OTHER_ORG,
      specId: OTHER_SPEC,
      status: "running",
      taskId: "task_evidence_wrong_org",
      taskKind: "plan",
    });
    const port = new PgRecoveryEvidencePort(owner());
    // Receipt claims our SPEC but the run belongs to OTHER_SPEC.
    await expect(
      port.verifyOwnedReceipt({
        expectedSpecId: SPEC,
        receipt: enqueued(SPEC, runId, "task_evidence_wrong_org"),
      }),
    ).resolves.toBeUndefined();
    // Expected OTHER_SPEC matches the row, but settlement always passes the queue entry's
    // exact spec — wrong expectedSpecId still fails closed.
    await expect(
      port.verifyOwnedReceipt({
        expectedSpecId: SPEC,
        receipt: enqueued(OTHER_SPEC, runId, "task_evidence_wrong_org"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects halted / inactive owner runs", async () => {
    const runId = "run_evidence_halted";
    await seedRun(owner(), runId, "halted");
    const port = new PgRecoveryEvidencePort(owner());
    await expect(
      port.verifyOwnedReceipt({
        expectedSpecId: SPEC,
        receipt: alreadyRunning(SPEC, runId),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a non-plan task on an otherwise valid enqueued receipt", async () => {
    const runId = "run_evidence_non_plan";
    const taskId = "task_evidence_write";
    await seedRun(owner(), runId, "running");
    await owner().query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'write', 'write', 'running', 'writer', 'fake', 'm')
       ON CONFLICT (task_id) DO UPDATE SET kind = 'write', run_id = EXCLUDED.run_id`,
      [taskId, runId, ORG],
    );
    const port = new PgRecoveryEvidencePort(owner());
    await expect(
      port.verifyOwnedReceipt({
        expectedSpecId: SPEC,
        receipt: enqueued(SPEC, runId, taskId),
      }),
    ).resolves.toBeUndefined();
  });
});
