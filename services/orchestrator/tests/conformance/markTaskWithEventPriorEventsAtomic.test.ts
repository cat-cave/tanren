// STANDING CONFORMANCE — audit finding D2 writer-seam extension. The
// `RunStateWriter.updateTaskWithEvent` seam now accepts an optional
// `priorEvents` array; when present, those events are appended on the SAME
// in-transaction client BEFORE the row UPDATE + terminal event, so the
// pre-terminal observation events (e.g. the review-stage verdict) live or
// die TOGETHER with the row + terminal event (autonomy-engine.md §1c
// single-finalize invariant, extended to the pre-terminal observation).
//
// THIS SUITE pins the atomicity proof against a REAL Postgres + the
// `DirectRunStateWriter`, gated behind TANREN_RLS_DB_TEST=1. Companion to
// `markTaskWithEventAtomic.test.ts`; split out to keep that file under the
// 500-line architecture cap.
//
// Tests:
//   (1) happy path — review.approved (prior) + row + task.completed all land
//       under the task, ordered (prior first), in one transaction.
//   (2) atomicity — a malformed prior event payload throws inside the
//       transaction → ROLLBACK; the row stays running, NO events land.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { DirectRunStateWriter } from "../../src/engine/worker/index.js";
import {
  createWriteEndpointHarness,
  enabled,
  ORG,
  PLAN_TASK,
  PROJECT,
  seedRun,
  SPEC,
} from "../planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

async function seedChildTask(
  ownerPool: ReturnType<ReturnType<typeof createWriteEndpointHarness>["ownerPool"]>,
  runId: string,
  taskId: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO tasks (task_id, run_id, org_id, parent_task_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, $4, 'review', 't', 'running', 'answerer', 'fake', NULL)`,
    [taskId, runId, ORG, PLAN_TASK],
  );
}

describeDb("updateTaskWithEvent + priorEvents atomic 3-write (audit finding D2)", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  it("(D2) bundles review.approved (prior) + row + task.completed in ONE tx, ordered", async () => {
    const runId = "run_prior_events_direct";
    const taskId = "task_prior_events_direct";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    await runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "done", outcome: "ok" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          orgId: ORG,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "approved" } as never,
        },
        priorEvents: [
          {
            runId,
            taskId,
            specId: SPEC,
            projectId: PROJECT,
            orgId: ORG,
            eventType: "review.approved",
            payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1, reviewer: "alice" } as never,
            idempotencyKey: `${runId}:review:approved`,
          },
        ],
      }),
    );

    // All three writes landed under the task in ONE tx: the pre-terminal
    // review.approved FIRST (chronologically — lower id), then the terminal
    // task.completed; the row landed `done`.
    const events = await ownerPool().query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE task_id = $1 ORDER BY id ASC",
      [taskId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["review.approved", "task.completed"]);
    const row = await ownerPool().query<{ status: string }>("SELECT status FROM tasks WHERE task_id = $1", [taskId]);
    expect(row.rows[0]?.status).toBe("done");
  });

  it("(D2) a malformed prior event payload rolls back the WHOLE bundle", async () => {
    const runId = "run_prior_events_rollback";
    const taskId = "task_prior_events_rollback";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    const fail = runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "done", outcome: "ok" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          orgId: ORG,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "approved" } as never,
        },
        // `review.approved` requires prNumber:number — passing a string fails
        // the registry Zod parse inside the transaction, rolling row + event
        // back too.
        priorEvents: [
          {
            runId,
            taskId,
            specId: SPEC,
            projectId: PROJECT,
            orgId: ORG,
            eventType: "review.approved",
            payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: "not-a-number" } as never,
            idempotencyKey: `${runId}:review:approved`,
          },
        ],
      }),
    );
    await expect(fail).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM tasks WHERE task_id = $1", [taskId]);
    expect(row.rows[0]?.status).toBe("running");
    const events = await ownerPool().query("SELECT 1 FROM events WHERE task_id = $1", [taskId]);
    expect(events.rowCount).toBe(0);
  });

  // Round-3 audit finding H-R3.2: a retried atomic write with the SAME
  // (runId, idempotencyKey) on a prior event MUST NOT double-emit — the
  // partial unique index `events_prior_idempotency_unique` + ON CONFLICT
  // DO NOTHING dedupe the bundle's pre-terminal leg in the SAME way
  // `events_task_terminal_unique` + `appendIfAbsent` dedupe the terminal leg.
  it("(H-R3.2) retried priorEvents with the SAME idempotencyKey dedupe (one row each)", async () => {
    const runId = "run_prior_events_retry";
    const taskId = "task_prior_events_retry";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    const bundle = () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "done", outcome: "ok" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          orgId: ORG,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "approved" } as never,
        },
        priorEvents: [
          {
            runId,
            taskId,
            specId: SPEC,
            projectId: PROJECT,
            orgId: ORG,
            eventType: "review.approved",
            payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1, reviewer: "alice" } as never,
            idempotencyKey: `${runId}:review:approved`,
          },
        ],
      });

    // First call — fresh write of the whole bundle.
    const first = await runWithJobOrgId(ORG, bundle);
    expect(first.alreadyTerminal).toBe(false);
    // Retry — every prior event AND the terminal event dedupe. The row UPDATE
    // is also a no-op (the row is already terminal `done`).
    const retry = await runWithJobOrgId(ORG, bundle);
    expect(retry.alreadyTerminal).toBe(true);

    // EXACTLY 1 review.approved + 1 task.completed (not 2 of either).
    const events = await ownerPool().query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE task_id = $1 ORDER BY id ASC",
      [taskId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["review.approved", "task.completed"]);
  });
});
