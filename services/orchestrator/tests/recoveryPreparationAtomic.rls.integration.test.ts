// Real-Postgres proof for the recovery preparation and percolation retirement
// authorities. Gated by TANREN_RLS_DB_TEST=1 like the other enforced-RLS suites.

import { resetSystemPool, setSystemPool } from "@tanren/db";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MtlsFetch, RecoveryPreparationInput, RecoveryPreparationOutcome } from "../src/engine/contracts/index.js";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { ConflictRecoveryDisposition } from "../src/engine/contracts/conflictResolution.js";
import { PgPercolationSettler } from "../src/engine/dag/percolationBuild.js";
import { conflictSignatureOf } from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../src/engine/worker/index.js";
import { AllowAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";
import { createWriteEndpointHarness, enabled, fetchInto } from "./planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

interface Candidate {
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
  queueId: string;
}

function candidate(name: string): Candidate {
  return {
    orgId: `org_prepare_${name}`,
    projectId: `project_prepare_${name}`,
    specId: `spec_prepare_${name}`,
    runId: `run_prepare_${name}`,
    queueId: `queue_prepare_${name}`,
  };
}

async function seedCandidate(
  owner: Pool,
  value: Candidate,
  specStatus = "in_flight",
  queueStatus: "queued" | "merging" = "queued",
): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [value.orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/recovery.git', $2)`,
    [value.projectId, value.orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, $4, $5)`,
    [value.specId, value.projectId, value.orgId, `description for ${value.specId}`, specStatus],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [value.runId, value.specId, value.projectId, value.orgId],
  );
  await owner.query(
    `INSERT INTO merge_queue
       (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '17', CASE WHEN $6 = 'merging' THEN now() END)`,
    [
      value.queueId,
      value.runId,
      value.specId,
      value.projectId,
      value.orgId,
      queueStatus,
      `https://github.example/pulls/${value.queueId}`,
    ],
  );
}

function preparationInput(value: Candidate, steering = `steering for ${value.specId}`): RecoveryPreparationInput {
  const newContext = `upstream context for ${value.specId}`;
  const otherSpecId = `ancestor_${value.specId}`;
  return {
    orgId: value.orgId,
    projectId: value.projectId,
    specId: value.specId,
    oldRunId: value.runId,
    queueId: value.queueId,
    steeringNote: steering,
    reopenStatus: "open",
    route: {
      kind: "planner_replan",
      newContext,
      otherSpecId,
      conflictSignature: conflictSignatureOf(newContext, otherSpecId),
    },
  };
}

function owned(outcome: RecoveryPreparationOutcome) {
  expect(outcome.kind).toBe("owned");
  if (outcome.kind !== "owned") throw new Error(`expected owned preparation, got ${outcome.kind}`);
  return outcome;
}

async function assertSinglePreparedSet(owner: Pool, value: Candidate, steering: string): Promise<void> {
  const spec = await owner.query<{ status: string; description: string }>(
    "SELECT status, description FROM specs WHERE spec_id = $1",
    [value.specId],
  );
  const runs = await owner.query<{ run_id: string; status: string; trigger: string }>(
    "SELECT run_id, status, trigger FROM runs WHERE spec_id = $1 AND run_id <> $2 ORDER BY run_id",
    [value.specId, value.runId],
  );
  const successor = runs.rows[0];
  const tasks = await owner.query<{ task_id: string; status: string; kind: string }>(
    "SELECT task_id, status, kind FROM tasks WHERE run_id = $1",
    [successor?.run_id],
  );
  const jobs = await owner.query<{ task_id: string; task_kind: string }>(
    "SELECT task_id, task_kind FROM job_queue WHERE run_id = $1",
    [successor?.run_id],
  );
  const events = await owner.query<{ run_id: string; event_type: string; idempotency_key: string | null }>(
    "SELECT run_id, event_type, idempotency_key FROM events WHERE spec_id = $1 ORDER BY id",
    [value.specId],
  );

  expect(spec.rows[0]?.status).toBe("in_flight");
  expect(spec.rows[0]?.description.split(steering)).toHaveLength(2);
  expect(runs.rows).toHaveLength(1);
  expect(successor).toMatchObject({ status: "queued", trigger: "replan_routed" });
  expect(tasks.rows).toEqual([expect.objectContaining({ status: "queued", kind: "plan" })]);
  expect(jobs.rows).toEqual([expect.objectContaining({ task_kind: "plan", task_id: tasks.rows[0]?.task_id })]);
  expect(events.rows.filter((event) => event.run_id === value.runId).map((event) => event.event_type)).toEqual([
    "merge.conflict.replan_routed",
    "recovery.replan_queued",
  ]);
  expect(events.rows.filter((event) => event.run_id === successor?.run_id).map((event) => event.event_type)).toEqual([
    "run.queued",
    "task.queued",
  ]);
  expect(
    events.rows
      .filter((event) => event.run_id === value.runId)
      .every((event) => event.idempotency_key?.startsWith("recovery-prepare:v1:") === true),
  ).toBe(true);
}

function dependent(value: Candidate): SpeculativeDependent {
  return {
    specId: value.specId,
    runId: value.runId,
    speculativeBase: null,
    integratedAncestorShas: { spec_ancestor: "sha_old" },
    verifiedAncestorShas: { spec_ancestor: "sha_old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

describeDb("atomic recovery preparation and percolation retirement — real PG", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(async () => {
    await harness.setUp();
    setSystemPool(ownerPool());
  }, 60_000);
  afterEach(async () => {
    await ownerPool().query("DELETE FROM merge_queue");
  });
  afterAll(async () => {
    resetSystemPool();
    await harness.tearDown();
  }, 30_000);

  it("Direct and HTTP produce the same single successor/run/task/job/event authority", async () => {
    const directCandidate = candidate("direct_parity");
    const httpCandidate = candidate("http_parity");
    await seedCandidate(ownerPool(), directCandidate);
    await seedCandidate(ownerPool(), httpCandidate);
    const directInput = preparationInput(directCandidate);
    const httpInput = preparationInput(httpCandidate);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });

    const direct = owned(await new DirectRunStateWriter(runtimePool()).prepareRecovery(directInput));
    const http = owned(
      await new HttpRunStateWriter("https://control.internal", fetchInto(app)).prepareRecovery(httpInput),
    );

    expect({ kind: direct.kind, newlyPrepared: direct.newlyPrepared, receiptKind: direct.receipt.kind }).toEqual({
      kind: "owned",
      newlyPrepared: true,
      receiptKind: "planner_replan",
    });
    expect({ kind: http.kind, newlyPrepared: http.newlyPrepared, receiptKind: http.receipt.kind }).toEqual({
      kind: "owned",
      newlyPrepared: true,
      receiptKind: "planner_replan",
    });
    await assertSinglePreparedSet(ownerPool(), directCandidate, directInput.steeringNote);
    await assertSinglePreparedSet(ownerPool(), httpCandidate, httpInput.steeringNote);
  });

  it("serializes concurrent calls and exact replay while rejecting changed operation bytes", async () => {
    const value = candidate("concurrent_replay");
    await seedCandidate(ownerPool(), value);
    const input = preparationInput(value);
    const writer = new DirectRunStateWriter(runtimePool());

    const results = (await Promise.all([writer.prepareRecovery(input), writer.prepareRecovery(input)])).map((result) =>
      owned(result),
    );
    expect(results.map((result) => result.newlyPrepared).sort()).toEqual([false, true]);
    expect(await writer.prepareRecovery(input)).toMatchObject({ kind: "owned", newlyPrepared: false });
    await expect(
      writer.prepareRecovery({ ...input, steeringNote: `${input.steeringNote} changed` }),
    ).resolves.toMatchObject({ kind: "conflict" });
    await assertSinglePreparedSet(ownerPool(), value, input.steeringNote);
    const receipt = results[0]!.receipt;
    if (receipt.run.kind !== "enqueued") throw new Error("expected enqueued preparation receipt");
    await ownerPool().query("UPDATE runs SET status = 'halted' WHERE run_id = $1", [receipt.run.replanRunId]);
    await expect(writer.readRecoveryPreparation(input)).resolves.toEqual({
      kind: "owned",
      receipt,
      newlyPrepared: false,
    });
  });

  it("reads through a commit-then-response-loss without preparing a second successor", async () => {
    const value = candidate("response_loss");
    await seedCandidate(ownerPool(), value);
    const input = preparationInput(value);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const intoApp = fetchInto(app);
    let drop = true;
    const lossy: MtlsFetch = async (url, init) => {
      const response = await intoApp(url, init);
      if (drop && new URL(url).pathname === "/internal/prepare-recovery") {
        drop = false;
        throw new Error("response lost after recovery preparation commit");
      }
      return response;
    };

    await expect(
      new HttpRunStateWriter("https://control.internal", lossy).prepareRecovery(input),
    ).resolves.toMatchObject({ kind: "owned", newlyPrepared: false });
    await assertSinglePreparedSet(ownerPool(), value, input.steeringNote);
  });

  it("rolls steering, reopen, successor, job, and events back when routing-event insertion fails", async () => {
    const value = candidate("event_rollback");
    await seedCandidate(ownerPool(), value, "review");
    const input = preparationInput(value);
    const before = await ownerPool().query<{ status: string; description: string }>(
      "SELECT status, description FROM specs WHERE spec_id = $1",
      [value.specId],
    );
    await ownerPool().query("REVOKE INSERT ON TABLE events FROM tanren_app");
    try {
      await expect(new DirectRunStateWriter(runtimePool()).prepareRecovery(input)).resolves.toMatchObject({
        kind: "failure",
        reason: "write_failed",
      });
    } finally {
      await ownerPool().query("GRANT INSERT ON TABLE events TO tanren_app");
    }
    const after = await ownerPool().query<{ status: string; description: string }>(
      "SELECT status, description FROM specs WHERE spec_id = $1",
      [value.specId],
    );
    const successors = await ownerPool().query("SELECT run_id FROM runs WHERE spec_id = $1 AND run_id <> $2", [
      value.specId,
      value.runId,
    ]);
    const events = await ownerPool().query("SELECT id FROM events WHERE spec_id = $1", [value.specId]);
    expect(after.rows).toEqual(before.rows);
    expect(successors.rowCount).toBe(0);
    expect(events.rowCount).toBe(0);
  });

  it("fails terminal/needs-attention races and wrong old tuples without mutation", async () => {
    const writer = new DirectRunStateWriter(runtimePool());
    const outcomes: RecoveryPreparationOutcome[] = [];
    for (const status of ["cancelled", "halted", "merged", "needs_attention"] as const) {
      const value = candidate(`status_${status}`);
      await seedCandidate(ownerPool(), value, status);
      outcomes.push(await writer.prepareRecovery(preparationInput(value)));
    }
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "terminal_noop", status: "cancelled" }),
      expect.objectContaining({ kind: "terminal_noop", status: "halted" }),
      expect.objectContaining({ kind: "terminal_noop", status: "merged" }),
      expect.objectContaining({ kind: "conflict" }),
    ]);
    const exact = candidate("wrong_tuple_exact");
    const other = candidate("wrong_tuple_other");
    await seedCandidate(ownerPool(), exact);
    await seedCandidate(ownerPool(), other);
    const input = preparationInput(exact);
    await expect(writer.prepareRecovery({ ...input, queueId: other.queueId })).resolves.toMatchObject({
      kind: "conflict",
    });
    await expect(writer.prepareRecovery({ ...input, orgId: other.orgId })).resolves.toMatchObject({
      kind: "conflict",
    });
    const successors = await ownerPool().query("SELECT run_id FROM runs WHERE spec_id = $1 AND run_id <> $2", [
      exact.specId,
      exact.runId,
    ]);
    expect(successors.rowCount).toBe(0);
  });

  it("PgPercolationSettler retires once before marker clear and recovers lost acknowledgement exactly", async () => {
    const value = candidate("percolation_replay");
    await seedCandidate(ownerPool(), value, "in_flight", "merging");
    const preparation = owned(await new DirectRunStateWriter(runtimePool()).prepareRecovery(preparationInput(value)));
    await ownerPool().query("UPDATE runs SET percolation_pending = $2::jsonb WHERE run_id = $1", [
      value.runId,
      JSON.stringify({ ancestorSpecId: "spec_ancestor", toSha: "sha_new", reexecRunId: value.runId }),
    ]);
    let route: ConflictRecoveryDisposition = { kind: "owned", receipt: preparation.receipt };
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const intoApp = fetchInto(app);
    let dropSettle = true;
    const lossy: MtlsFetch = async (url, init) => {
      const response = await intoApp(url, init);
      if (dropSettle && new URL(url).pathname === "/internal/settle-owned-recovery-and-dequeue") {
        dropSettle = false;
        throw new Error("owned-settle acknowledgement lost after commit");
      }
      return response;
    };
    const settler = new PgPercolationSettler(
      runtimePool(),
      new HttpRunStateWriter("https://control.internal", lossy),
      undefined,
      async () => route,
    );
    const pending = { ancestorSpecId: "spec_ancestor", toSha: "sha_new", reexecRunId: value.runId };
    const settleInput = { projectId: value.projectId, dependent: dependent(value), pending, reason: "cannot absorb" };

    await expect(settler.replan(settleInput)).resolves.toMatchObject({ result: "held" });
    const first = await ownerPool().query<{ xmin: string; status: string; percolation_pending: unknown }>(
      `SELECT mq.xmin::text, mq.status, r.percolation_pending
         FROM merge_queue mq JOIN runs r ON r.run_id = mq.run_id
        WHERE mq.queue_id = $1`,
      [value.queueId],
    );
    expect(first.rows[0]).toMatchObject({ status: "dequeued" });
    expect(first.rows[0]?.percolation_pending).not.toBeNull();

    if (preparation.receipt.run.kind !== "enqueued") throw new Error("expected enqueued receipt");
    route = {
      kind: "owned",
      receipt: {
        ...preparation.receipt,
        run: { ...preparation.receipt.run, plannerTaskId: "task_wrong_receipt" },
      },
    };
    await expect(settler.replan(settleInput)).resolves.toMatchObject({ result: "held" });
    const afterWrong = await ownerPool().query<{ xmin: string; percolation_pending: unknown }>(
      `SELECT mq.xmin::text, r.percolation_pending
         FROM merge_queue mq JOIN runs r ON r.run_id = mq.run_id
        WHERE mq.queue_id = $1`,
      [value.queueId],
    );
    expect(afterWrong.rows[0]?.xmin).toBe(first.rows[0]?.xmin);
    expect(afterWrong.rows[0]?.percolation_pending).not.toBeNull();

    route = { kind: "owned", receipt: preparation.receipt };
    await expect(settler.replan(settleInput)).resolves.toEqual({
      result: "replanned",
      reexecRunId: preparation.receipt.run.replanRunId,
    });
    const final = await ownerPool().query<{ xmin: string; percolation_pending: unknown; successor_status: string }>(
      `SELECT mq.xmin::text, old_run.percolation_pending, successor.status AS successor_status
         FROM merge_queue mq
         JOIN runs old_run ON old_run.run_id = mq.run_id
         JOIN runs successor ON successor.run_id = $2
        WHERE mq.queue_id = $1`,
      [value.queueId, preparation.receipt.run.replanRunId],
    );
    const dequeues = await ownerPool().query(
      "SELECT id FROM events WHERE run_id = $1 AND event_type = 'merge.dequeued'",
      [value.runId],
    );
    expect(final.rows[0]).toMatchObject({
      xmin: first.rows[0]?.xmin,
      percolation_pending: null,
      successor_status: "queued",
    });
    expect(dequeues.rowCount).toBe(1);
  });
});
