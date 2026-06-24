// task-row persistence helpers for the planner-feedback loop.
// Subtasks reuse the existing `tasks` table (Option B in the spec): the
// planner task is the parent and writer/check tasks reference it via
// `parent_task_id`. The existing `attempt` column carries writer-retry
// attempts. No new table is required.
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { PlanAnswer } from "../answerers/schemas/index.js";
import { resolveWritableClient } from "../data/orgScopedDb.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// RLS R2 cohort-2 (tasks write path): these helpers are handed EITHER the shared
// pool (from `runPlannerLoopWorkflow`) or a specific in-transaction client. When
// it is the pool, route the INSERT/UPDATE through the ambient org-scoped client
// if a `runWithOrgScope` scope is open, falling back to the pool when none
// (inert, R1-equivalent). When it is a specific client, use it verbatim. The
// SQL/columns/params are unchanged so behavior is identical — `subtaskStages`
// tests (which hand a bare query-only stub, not a pool) stay green.
//
// each helper also takes an optional `writer`. When present
// (remote-writes on), the tasks INSERT/UPDATE routes through the control-plane
// endpoint (the data plane no longer writes `tasks` directly); the persisted row
// is byte-identical (the server runs the SAME fixed SQL). Absent (the default),
// the in-process org-scoped write runs as before.

export type ChildTaskKind = "write" | "check" | "audit" | "triage" | "convergence" | "demo" | "designOracle";

export interface ChildTaskInsert {
  taskId: string;
  runId: string;
  kind: ChildTaskKind;
  title: string;
  parentTaskId: string;
  agentKind: "writer" | "answerer";
  cli: string;
  model: string | null;
}

export async function insertPlannerTask(
  pool: LoopQueryClient,
  runId: string,
  taskId: string,
  planner: AnswererAdapter<PlanAnswer>,
  writer?: RunStateWriter,
): Promise<void> {
  if (writer !== undefined) {
    await writer.insertTask({
      taskId,
      runId,
      kind: "plan",
      title: "plan spec",
      status: "running",
      agentKind: "answerer",
      cli: planner.cli,
      model: null,
      setStartedAt: true,
    });
    return;
  }
  await resolveWritableClient(pool).query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model)
     VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), 'plan', 'plan spec', 'running', now(), 'answerer', $3, NULL)`,
    [taskId, runId, planner.cli],
  );
}

export async function insertChildTask(
  pool: LoopQueryClient,
  task: ChildTaskInsert,
  writer?: RunStateWriter,
): Promise<void> {
  if (writer !== undefined) {
    await writer.insertTask({
      taskId: task.taskId,
      runId: task.runId,
      kind: task.kind,
      title: task.title,
      parentTaskId: task.parentTaskId,
      status: "running",
      agentKind: task.agentKind,
      cli: task.cli,
      model: task.model,
      setStartedAt: true,
    });
    return;
  }
  await resolveWritableClient(pool).query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, parent_task_id, status, started_at, agent_kind, cli, model)
     VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), $3, $4, $5, 'running', now(), $6, $7, $8)`,
    [task.taskId, task.runId, task.kind, task.title, task.parentTaskId, task.agentKind, task.cli, task.model],
  );
}

export async function markTaskDone(
  pool: LoopQueryClient,
  taskId: string,
  outcome: "passed" | "rejected_by_checker" | "rejected_by_auditor" | "window_exhausted",
  writer?: RunStateWriter,
): Promise<void> {
  if (writer !== undefined) {
    await writer.updateTask({ taskId, transition: "done", outcome });
    return;
  }
  await resolveWritableClient(pool).query(
    `UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1`,
    [taskId, outcome],
  );
}

// Move a subtask row to a hard FAILED terminal with its failure kind. Used when a
// writer run did NOT complete (crashed / timed out): the task must NOT be laundered
// to a `done`/`passed` row whose partial/empty diff then flows downstream as a
// success. Mirrors the merge dispatcher's `failed_with_kind` transition (same fixed
// UPDATE), so the row reads status='failed', outcome='failed', failure_kind=$kind.
export async function markTaskFailed(
  pool: LoopQueryClient,
  taskId: string,
  failureKind: string,
  writer?: RunStateWriter,
): Promise<void> {
  if (writer !== undefined) {
    await writer.updateTask({ taskId, transition: "failed_with_kind", failureKind });
    return;
  }
  await resolveWritableClient(pool).query(
    `UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1`,
    [taskId, failureKind],
  );
}

// Idempotent FAILED-terminal transition: move a task row to `failed` ONLY when it
// is still `status='running'`. Used by the finalize guard
// (`runStageBodyWithFinalizeGuard`) so a POST-success throw — the cost-recorder
// fails after a successful provider call, or appendEvent fails after the row was
// already moved to `done` by a clean branch — leaves the existing terminal row
// alone (a `done`/`passed` row a clean branch already wrote is not clobbered to
// `failed`; that case is a missing-event problem, not a missing-failure-row
// problem). The `WHERE status='running'` guard is the idempotency primitive: a
// re-run sees no `running` row and is a no-op. Mirrors `markTaskFailed` shape but
// adds the guard; both routes (in-process direct UPDATE + `RunStateWriter`) honor it.
export async function markTaskFailedIfRunning(
  pool: LoopQueryClient,
  taskId: string,
  failureKind: string,
  writer?: RunStateWriter,
): Promise<void> {
  if (writer !== undefined) {
    await writer.updateTask({ taskId, transition: "failed_with_kind_if_running", failureKind });
    return;
  }
  await resolveWritableClient(pool).query(
    `UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1 AND status = 'running'`,
    [taskId, failureKind],
  );
}

// --- ATOMIC terminal row + terminal `task.*` event helpers (task #39) -------
//
// The single-finalize invariant (autonomy-engine.md §1c) requires the terminal
// row UPDATE and its matching `task.*` event to live or die TOGETHER — a
// crash/DB failure between the two strands the row terminal-`done` with no
// `task.completed`, which the live timeline + the gate downstream both
// mis-interpret. These three wrappers combine the row + event into ONE atomic
// op through the writer seam (`updateTaskWithEvent`) — its direct impl opens
// `runWithOrgScope` and runs both writes on the SAME in-transaction client (the
// pattern `applyFinalizeLand` already uses for the merge-land transaction).
//
// `eventEnvelope` carries the durable lineage the `task.*` event needs (`runId`
// / `specId` / `projectId` for the events row + the org-derivation in SQL, plus
// `taskKind` for the payload). The call sites already have these in scope —
// they were already passing them to the separate `appendEvent` call.
//
// THE WRITER IS THE ATOMIC SEAM. Production wires a `RunStateWriter` (either
// `Direct`-in-process, which itself opens `runWithOrgScope`, or `Http`-remote,
// which posts to `/internal/update-task-with-event`); the seam is the SOLE
// guarantor of atomicity. The no-writer fallback paths below are TEST-ONLY:
// they run the row UPDATE + a separate `appendEvent` call (the same shape the
// pre-#39 split issued) so unit-test harnesses that hand a fake `{ query }`
// pool + a recording appendEvent (e.g. `subtaskLoopStages.test.ts`) keep
// observing terminal events through the recorder. The atomicity contract is
// asserted in the conformance test (`markTaskWithEventAtomic.test.ts`)
// against a real Postgres + the `DirectRunStateWriter`.

/** The durable lineage a terminal `task.*` event always carries (task #39). */
export interface TerminalTaskEventEnvelope {
  runId: string;
  specId: string;
  projectId: string;
  taskKind: string;
}

/**
 * A narrow event-append callback for the no-writer test fallback (task #39):
 * appends ONE terminal `task.*` event with the plain payload shape these
 * helpers construct internally (`{ taskKind, failureKind?, message? }`). The
 * call site adapts its own typed `appendEvent` to this shape — the
 * registry-typed payload schema is byte-identical (the `task.completed` /
 * `task.failed` payloads are exactly `{ taskKind, ... }` records). Production
 * NEVER hits this seam (the writer path commits the event atomically with the
 * row inside `RunStateWriter.updateTaskWithEvent`).
 */
type TerminalTaskEventAppend = (
  eventType: "task.completed" | "task.failed",
  payload: Record<string, unknown>,
  taskId: string,
) => Promise<void>;

/** Shared option shape for the atomic terminal-pair helpers (task #39). */
export interface MarkTaskTerminalOpts {
  pool: LoopQueryClient;
  writer?: RunStateWriter;
  taskId: string;
  envelope: TerminalTaskEventEnvelope;
  /**
   * No-writer test fallback's appendEvent sink (the stage's recorder); absent
   * ⇒ the no-writer path runs an unwrapped row UPDATE via the pool + emits no
   * event (matches the pre-#39 direct-path behavior).
   */
  appendEventFallback?: TerminalTaskEventAppend;
}

/**
 * The atomic SUCCESS-terminal pair (task #39): move the task row to `done` AND
 * append its `task.completed` event in ONE org-scoped transaction. Replaces the
 * split `markTaskDone(...)` + a separate `appendEvent("task.completed", ...)`
 * call — see the per-call-site migration notes in PR #674 (task #39).
 *
 * IDEMPOTENT RETRY (task #40 Class B): the writer's `updateTaskWithEvent`
 * returns `{ alreadyTerminal }` — `true` when the server-side commit landed
 * but its HTTP response was DROPPED en route, and this is a retry whose event
 * INSERT deduped against the partial unique index `events_task_terminal_unique`.
 * The original row + event are durable in their original form; we SWALLOW the
 * `alreadyTerminal: true` outcome silently (the work is durably done — there
 * is nothing to escalate). This helper returns `void` either way.
 */
export async function markTaskDoneWithEvent(
  opts: MarkTaskTerminalOpts & {
    outcome: "passed" | "rejected_by_checker" | "rejected_by_auditor" | "window_exhausted";
  },
): Promise<void> {
  const { pool, writer, taskId, envelope, appendEventFallback, outcome } = opts;
  if (writer !== undefined) {
    // The outcome is consumed silently — the seam's idempotency-retry signal
    // (task #40 Class B) is bookkeeping the helper does NOT propagate; the
    // caller's view is "the work is done", regardless of whether THIS call or
    // an earlier dropped-response call actually wrote the row + event.
    await writer.updateTaskWithEvent({
      task: { taskId, transition: "done", outcome },
      event: {
        runId: envelope.runId,
        taskId,
        specId: envelope.specId,
        projectId: envelope.projectId,
        eventType: "task.completed",
        // Payload is registry-typed downstream by `PgEventStore.append`'s Zod
        // parse; the cast crosses the generic-payload seam (the runtime decode
        // is the ground truth).
        payload: { taskKind: envelope.taskKind } as never,
      },
    });
    return;
  }
  // No-writer test fallback: row UPDATE → event append (matches the pre-#39
  // split — atomicity is proven via the writer seam, not this path).
  await markTaskDone(pool, taskId, outcome);
  if (appendEventFallback !== undefined) {
    await appendEventFallback("task.completed", { taskKind: envelope.taskKind }, taskId);
  }
}

/**
 * The atomic HARD-FAILED-terminal pair (task #39): move the task row to
 * `failed` AND append `task.failed` in ONE org-scoped transaction. The optional
 * `message` carries the safe failure message the writer-failed branches
 * (`window_exhausted` / `crashed` / `timeout`) already emit on the event
 * payload — kept here so the migrated call site is a single combined call.
 *
 * IDEMPOTENT RETRY (task #40 Class B): like {@link markTaskDoneWithEvent},
 * a `{ alreadyTerminal: true }` outcome from the writer is SWALLOWED — the
 * original `task.failed` already landed and was retried after a dropped HTTP
 * response. The helper returns `void` either way.
 */
export async function markTaskFailedWithEvent(
  opts: MarkTaskTerminalOpts & { failureKind: string; message?: string },
): Promise<void> {
  const { pool, writer, taskId, envelope, appendEventFallback, failureKind, message } = opts;
  const payload: Record<string, unknown> = { taskKind: envelope.taskKind, failureKind };
  if (message !== undefined) {
    payload["message"] = message;
  }
  if (writer !== undefined) {
    await writer.updateTaskWithEvent({
      task: { taskId, transition: "failed_with_kind", failureKind },
      event: {
        runId: envelope.runId,
        taskId,
        specId: envelope.specId,
        projectId: envelope.projectId,
        eventType: "task.failed",
        // Payload is registry-typed downstream (see `markTaskDoneWithEvent`).
        payload: payload as never,
      },
    });
    return;
  }
  await markTaskFailed(pool, taskId, failureKind);
  if (appendEventFallback !== undefined) {
    await appendEventFallback("task.failed", payload, taskId);
  }
}

/**
 * The atomic GUARDED-FAILED-terminal pair (task #39): the finalize-guard's
 * idempotency primitive — move the task row to `failed` ONLY when it is still
 * `status='running'` AND append `task.failed` in ONE org-scoped transaction. The
 * row UPDATE is no-op when the row is already terminal (a clean branch beat us
 * to `done`); the `task.failed` event lands the FIRST TIME for this taskId as the
 * loud timeline signal (per `stageFailureKind.ts` §IDEMPOTENCY). The `message`
 * carries the safe stage-failure message the guard already passes.
 *
 * IDEMPOTENT RETRY (task #40 Class B): this helper is the data plane's recovery
 * after a dropped HTTP response from a PRIOR `updateTaskWithEvent` — the
 * canonical phantom-write scenario. The writer's outcome (`alreadyTerminal:
 * true` when the partial unique index `events_task_terminal_unique` deduped
 * the SAME-type re-INSERT) is SWALLOWED: the original `task.failed` already
 * landed at the original commit time, the row + event are durable, and the
 * caller's view is "the work is done". Returning `void` keeps the
 * finalize-guard catch path's contract: the recovery call doesn't surface as
 * a fresh error after the original write already landed. A DIFFERENT-type
 * cross-terminal case (an earlier `task.completed` already landed) stays
 * UNBLOCKED by the partial unique index `(task_id, event_type)` — the
 * `task.failed` lands cleanly alongside it as the loud outage signal (the
 * row state machine is the truth; the event timeline carries both).
 */
export async function markTaskFailedIfRunningWithEvent(
  opts: MarkTaskTerminalOpts & { failureKind: string; message: string },
): Promise<void> {
  const { pool, writer, taskId, envelope, appendEventFallback, failureKind, message } = opts;
  const payload = { taskKind: envelope.taskKind, failureKind, message };
  if (writer !== undefined) {
    await writer.updateTaskWithEvent({
      task: { taskId, transition: "failed_with_kind_if_running", failureKind },
      event: {
        runId: envelope.runId,
        taskId,
        specId: envelope.specId,
        projectId: envelope.projectId,
        eventType: "task.failed",
        // Payload is registry-typed downstream (see `markTaskDoneWithEvent`).
        payload: payload as never,
      },
    });
    return;
  }
  await markTaskFailedIfRunning(pool, taskId, failureKind);
  if (appendEventFallback !== undefined) {
    await appendEventFallback("task.failed", payload, taskId);
  }
}
