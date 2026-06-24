// STANDING CONFORMANCE — atomic terminal row + terminal `task.*` event seam
// (task #39 — critic-arc R2 NEW#1 / R3 BLOCKING: the prior split issued the
// row UPDATE and the `task.completed` / `task.failed` event INSERT as TWO
// separate writes, so a crash/DB failure between them stranded the row
// terminal-`done` with no event — autonomy-engine.md §1c single-finalize
// invariant violation). The migration combined the pair into ONE org-scoped
// transaction (mirroring `applyFinalizeLand` for the merge-land transaction).
//
// THIS SUITE pins both the durability + the pairing constraint, against a REAL
// Postgres under the enforced `tanren_app` RLS role (no SQL mocks — the
// transaction shape is the contract here, and that can only be proven on a
// live engine). Tests:
//
//   1. happy path — `updateTaskWithEvent` lands the row UPDATE + event INSERT
//      together (one tx, both rows visible at commit) on every terminal pair.
//   2. invalid payload — the event payload fails the registry Zod parse →
//      `PgEventStore.append` THROWS inside the transaction → ROLLBACK → neither
//      the row nor the event lands (atomicity: never partial).
//   3. mismatched pair — `done` ↔ `task.failed` is rejected by
//      `terminalPairSchema` BEFORE any DB I/O (the row stays `running`).
//   4. non-terminal transition — `running` ↔ `task.completed` is rejected by
//      `terminalPairSchema` BEFORE any DB I/O (the atomic seam admits ONLY
//      terminal transitions; a non-terminal pair would imply a phantom
//      `task.completed` against a still-running row).
//   5. schema refinement — every valid (transition, eventType) pair passes the
//      refinement; every mismatch fails (the seam's TYPED pairing matrix).
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL, exactly like
// the planeSplitP3RemoteWrites cohort. Shares `planeSplitP3RemoteWritesHarness`
// for the throwaway DB lifecycle + tenant constants + the in-process mTLS shim.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { AllowAllPeerVerifier } from "../../src/engine/contracts/index.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../../src/engine/worker/index.js";
import { terminalPairSchema } from "../../src/engine/worker/runStateLifecycleSql.js";
import { createInternalRunStateWriteRoutes } from "../../src/routes/internal/runStateWrites.js";
import {
  createWriteEndpointHarness,
  enabled,
  fetchInto,
  ORG,
  PLAN_TASK,
  PROJECT,
  seedRun,
  SPEC,
} from "../planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

// Insert one running `tasks` row the atomic seam will move to terminal. Reuses
// the harness's `seedRun` (which already inserts the plan task on `PLAN_TASK`),
// then adds a fresh per-test child task with the run as parent.
async function seedChildTask(
  ownerPool: ReturnType<ReturnType<typeof createWriteEndpointHarness>["ownerPool"]>,
  runId: string,
  taskId: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO tasks (task_id, run_id, org_id, parent_task_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, $4, 'write', 't', 'running', 'writer', 'fake', NULL)`,
    [taskId, runId, ORG, PLAN_TASK],
  );
}

describeDb("markTaskWithEvent atomic terminal-pair (task #39) — real PG, enforced RLS", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  // (1) Happy path — the row + the event commit together. Run BOTH the direct
  // writer (in-process `runWithOrgScope`) and the HTTP writer (control-plane
  // endpoint) so the same contract holds on both planes.
  it("(1a) DirectRunStateWriter.updateTaskWithEvent lands row + task.completed together", async () => {
    const runId = "run_atomic_direct_completed";
    const taskId = "task_atomic_direct_completed";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    await runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "done", outcome: "passed" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          eventType: "task.completed",
          payload: { taskKind: "write" } as never,
        },
      }),
    );

    const row = await ownerPool().query<{ status: string; outcome: string | null }>(
      "SELECT status, outcome FROM tasks WHERE task_id = $1",
      [taskId],
    );
    expect(row.rows[0]).toMatchObject({ status: "done", outcome: "passed" });
    const ev = await ownerPool().query<{ event_type: string; payload: { taskKind: string } }>(
      "SELECT event_type, payload FROM events WHERE task_id = $1 AND event_type = 'task.completed'",
      [taskId],
    );
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]?.payload.taskKind).toBe("write");
  });

  it("(1b) HttpRunStateWriter.updateTaskWithEvent lands row + task.failed together", async () => {
    const runId = "run_atomic_http_failed";
    const taskId = "task_atomic_http_failed";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));
    await runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "failed_with_kind", failureKind: "crashed" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          eventType: "task.failed",
          payload: { taskKind: "write", failureKind: "crashed", message: "boom" } as never,
        },
      }),
    );

    const row = await ownerPool().query<{ status: string; failure_kind: string }>(
      "SELECT status, failure_kind FROM tasks WHERE task_id = $1",
      [taskId],
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", failure_kind: "crashed" });
    const ev = await ownerPool().query<{ payload: { taskKind: string; failureKind: string } }>(
      "SELECT payload FROM events WHERE task_id = $1 AND event_type = 'task.failed'",
      [taskId],
    );
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]?.payload).toMatchObject({ taskKind: "write", failureKind: "crashed" });
  });

  // (2) Atomicity — an INVALID event payload makes the event INSERT throw
  // inside the transaction; the whole tx rolls back, so the row stays
  // `running` (never a half-baked terminal row without its loud event).
  it("(2) an invalid event payload rolls back the whole transaction — row stays `running`", async () => {
    const runId = "run_atomic_rollback";
    const taskId = "task_atomic_rollback";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    // `task.completed` payload schema admits only the registered keys; passing
    // a `taskKind` of a non-string type fails the Zod parse inside
    // `PgEventStore.append`, which throws AFTER `applyUpdateTask` already ran
    // in the same tx — the throw rolls the WHOLE tx back.
    const fail = runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "done", outcome: "passed" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          eventType: "task.completed",
          payload: { taskKind: 42 } as never,
        },
      }),
    );
    await expect(fail).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM tasks WHERE task_id = $1", [taskId]);
    expect(row.rows[0]?.status).toBe("running");
    const ev = await ownerPool().query("SELECT 1 FROM events WHERE task_id = $1 AND event_type = 'task.completed'", [
      taskId,
    ]);
    expect(ev.rowCount).toBe(0);
  });

  // (3) Pairing refinement — `done` ↔ `task.failed` is rejected at the seam.
  it("(3) mismatched pair (`done` ↔ `task.failed`) is rejected BEFORE any DB I/O", async () => {
    const runId = "run_atomic_mismatched";
    const taskId = "task_atomic_mismatched";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    const fail = runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        task: { taskId, orgId: ORG, transition: "done", outcome: "passed" },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          eventType: "task.failed",
          payload: { taskKind: "write", failureKind: "crashed" } as never,
        },
      }),
    );
    await expect(fail).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM tasks WHERE task_id = $1", [taskId]);
    expect(row.rows[0]?.status).toBe("running");
    const events = await ownerPool().query("SELECT 1 FROM events WHERE task_id = $1", [taskId]);
    expect(events.rowCount).toBe(0);
  });

  // (4) Pairing refinement — a NON-TERMINAL transition is rejected at the
  // seam (the atomic primitive admits ONLY terminal transitions; running ↔
  // `task.completed` would imply a phantom completion against a running row).
  it("(4) non-terminal transition (`running` ↔ `task.completed`) is rejected BEFORE any DB I/O", async () => {
    const runId = "run_atomic_non_terminal";
    const taskId = "task_atomic_non_terminal";
    await seedRun(ownerPool(), runId);
    await seedChildTask(ownerPool(), runId, taskId);

    const writer = new DirectRunStateWriter(runtimePool());
    const fail = runWithJobOrgId(ORG, () =>
      writer.updateTaskWithEvent({
        // `running` is rejected by `terminalPairSchema.task.transition` enum.
        task: { taskId, orgId: ORG, transition: "running" as never },
        event: {
          runId,
          taskId,
          specId: SPEC,
          projectId: PROJECT,
          eventType: "task.completed",
          payload: { taskKind: "write" } as never,
        },
      }),
    );
    await expect(fail).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM tasks WHERE task_id = $1", [taskId]);
    expect(row.rows[0]?.status).toBe("running");
  });
});

// (5) Pure schema test — exercises the TYPED pairing matrix without a DB.
// Every valid (terminal transition, terminal event type) pair PARSES; every
// mismatch FAILS. The closed enum on each axis means a future transition or
// event type ADDED to the seam is forced through this matrix (the schema
// blocks anything outside both enums).
describe("terminalPairSchema — typed pairing matrix (task #39)", () => {
  const TERMINAL_OK: Array<[string, "task.completed" | "task.failed"]> = [
    ["done", "task.completed"],
    ["failed", "task.failed"],
    ["failed_with_kind", "task.failed"],
    ["failed_with_kind_if_running", "task.failed"],
  ];

  it.each(TERMINAL_OK)("valid pair: transition=%s eventType=%s passes", (transition, eventType) => {
    const result = terminalPairSchema.safeParse({
      task: { taskId: "t", orgId: ORG, transition, outcome: "passed", failureKind: "crashed" },
      event: { projectId: PROJECT, eventType, payload: { taskKind: "write" } },
    });
    expect(result.success).toBe(true);
  });

  const MISMATCHES: Array<[string, "task.completed" | "task.failed"]> = [
    ["done", "task.failed"],
    ["failed", "task.completed"],
    ["failed_with_kind", "task.completed"],
    ["failed_with_kind_if_running", "task.completed"],
  ];

  it.each(MISMATCHES)("mismatched pair: transition=%s eventType=%s fails", (transition, eventType) => {
    const result = terminalPairSchema.safeParse({
      task: { taskId: "t", orgId: ORG, transition, outcome: "passed", failureKind: "crashed" },
      event: { projectId: PROJECT, eventType, payload: { taskKind: "write" } },
    });
    expect(result.success).toBe(false);
  });

  const NON_TERMINAL = ["running", "running_attempt", "started", "cancelled"];
  it.each(NON_TERMINAL)("non-terminal transition (%s) is rejected", (transition) => {
    const result = terminalPairSchema.safeParse({
      task: { taskId: "t", orgId: ORG, transition },
      event: { projectId: PROJECT, eventType: "task.completed", payload: { taskKind: "write" } },
    });
    expect(result.success).toBe(false);
  });
});
