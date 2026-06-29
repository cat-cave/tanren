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

// Audit finding H3 sweep: `markTaskFailed` + `markTaskFailedIfRunning` (the
// non-atomic, optional-writer row-only failure helpers) are DELETED. Every
// caller in the workflow uses the atomic terminal pair (`markTaskFailedWithEvent`
// / `markTaskFailedIfRunningWithEvent`) below, which routes the row UPDATE +
// the `task.failed` event through `writer.updateTaskWithEvent` in ONE org-scoped
// transaction. There is no longer a path that updates the row without emitting
// the matching loud terminal event.

// --- ATOMIC terminal row + terminal `task.*` event helpers (task #39, audit
//     finding H3 sweep — writer is REQUIRED, no fallback arm) ----------------
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
// WRITER IS REQUIRED (audit finding H3, doctrine sweep): the prior shape
// branched on `if (writer !== undefined)` with a split-write fallback arm that
// ran the row UPDATE + a separate `appendEvent` call when no writer was
// wired. That fallback DEFEATED the atomic seam — it was reachable in
// production whenever `runStateWriterFromEnv` returned `undefined`
// (TANREN_DATA_PLANE_REMOTE_WRITES off), so the "TEST-ONLY" label was a
// fiction. The sweep makes the writer non-optional everywhere: production
// always wires the writer (via the boundary that now always returns one — see
// `runStateWriterFromEnv.ts`), and tests wire an `InMemoryRunStateWriter`
// fixture. The atomicity contract is the SOLE path; no fallback.

/** The durable lineage a terminal `task.*` event always carries (task #39). */
export interface TerminalTaskEventEnvelope {
  runId: string;
  specId: string;
  projectId: string;
  taskKind: string;
}

/** Shared option shape for the atomic terminal-pair helpers (task #39 + H3). */
export interface MarkTaskTerminalOpts {
  /** REQUIRED (audit finding H3 sweep — no fallback arm). */
  writer: RunStateWriter;
  taskId: string;
  envelope: TerminalTaskEventEnvelope;
}

/**
 * The atomic SUCCESS-terminal pair (task #39 + audit H3): move the task row
 * to `done` AND append its `task.completed` event in ONE org-scoped
 * transaction. Replaces the split `markTaskDone(...)` + a separate
 * `appendEvent("task.completed", ...)` call.
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
  const { writer, taskId, envelope, outcome } = opts;
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
}

/**
 * The atomic HARD-FAILED-terminal pair (task #39 + audit H3): move the task
 * row to `failed` AND append `task.failed` in ONE org-scoped transaction. The
 * optional `message` carries the safe failure message the writer-failed
 * branches (`window_exhausted` / `crashed` / `timeout`) already emit on the
 * event payload — kept here so the migrated call site is a single combined
 * call.
 *
 * IDEMPOTENT RETRY (task #40 Class B): like {@link markTaskDoneWithEvent},
 * a `{ alreadyTerminal: true }` outcome from the writer is SWALLOWED — the
 * original `task.failed` already landed and was retried after a dropped HTTP
 * response. The helper returns `void` either way.
 */
export async function markTaskFailedWithEvent(
  opts: MarkTaskTerminalOpts & { failureKind: string; message?: string },
): Promise<void> {
  const { writer, taskId, envelope, failureKind, message } = opts;
  const payload: Record<string, unknown> = { taskKind: envelope.taskKind, failureKind };
  if (message !== undefined) {
    payload["message"] = message;
  }
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
}

/**
 * The atomic GUARDED-FAILED-terminal pair (task #39 + audit H3): the
 * finalize-guard's idempotency primitive — move the task row to `failed` ONLY
 * when it is still `status='running'` AND append `task.failed` in ONE
 * org-scoped transaction. The row UPDATE is no-op when the row is already
 * terminal (a clean branch beat us to `done`); the `task.failed` event lands
 * the FIRST TIME for this taskId as the loud timeline signal (per
 * `stageFailureKind.ts` §IDEMPOTENCY). The `message` carries the safe
 * stage-failure message the guard already passes.
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
  const { writer, taskId, envelope, failureKind, message } = opts;
  const payload = { taskKind: envelope.taskKind, failureKind, message };
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
}

// --- task #46 + audit H3: PLANNER-LEVEL atomic terminal-pair wrappers ------
//
// Thin context-binding wrappers around `markTaskDoneWithEvent` /
// `markTaskFailedWithEvent` for the spec-implementation loop's planner task
// row. The prior `markTaskDone(...)` + a separate `appendEvent(...)` shape was
// a non-atomic split — a crash/DB blip between the two writes could strand the
// row terminal-`done` with no event (autonomy-engine.md §1c single-finalize
// invariant). These wrappers route every planner-level terminal call through
// the SAME atomic seam the writer / checker / auditor stage helpers use
// (`RunStateWriter.updateTaskWithEvent` — task #39), so the row UPDATE + the
// terminal `task.*` event commit in ONE org-scoped transaction.
//
// WRITER REQUIRED (audit finding H3 sweep): the wrappers no longer carry a
// `writer?:` deps-threading slot or an `appendEvent` fallback — the SOLE path
// is the atomic seam. Callers wire a real writer (production via the always-
// returning `runStateWriterFromEnv`, tests via `InMemoryRunStateWriter`).

/** The planner-task's run lineage the atomic terminal pair always carries. */
export interface PlannerTaskLineage {
  runId: string;
  specId: string;
  projectId: string;
}

/** Shared opts for both planner-task atomic-terminal-pair wrappers (task #46 + H3). */
export interface PlannerTerminalBase {
  /** REQUIRED (audit finding H3 sweep — no fallback arm). */
  writer: RunStateWriter;
  taskId: string;
  lineage: PlannerTaskLineage;
  taskKind: string;
}

/**
 * Atomic SUCCESS-terminal pair for the planner task: row → `done`/`passed` AND
 * the matching `task.completed` event in ONE org-scoped transaction through
 * `writer.updateTaskWithEvent`. Same contract as the writer/checker/auditor
 * stage helpers; this just hides the lineage so each call site reads as one
 * focused intention.
 */
export async function markPlannerTaskDoneWithEvent(
  opts: PlannerTerminalBase & {
    outcome: "passed" | "rejected_by_checker" | "rejected_by_auditor" | "window_exhausted";
  },
): Promise<void> {
  await markTaskDoneWithEvent({
    writer: opts.writer,
    taskId: opts.taskId,
    envelope: { ...opts.lineage, taskKind: opts.taskKind },
    outcome: opts.outcome,
  });
}

/**
 * Atomic FAILED-terminal pair for the planner task: row → `failed`/`failed_with_kind`
 * AND the matching `task.failed` event in ONE org-scoped transaction. The
 * `failureKind` rides on the row's `failure_kind` column AND the event payload
 * so the timeline + the row stay aligned; optional `message` carries the
 * human-readable cause.
 */
export async function markPlannerTaskFailedWithEvent(
  opts: PlannerTerminalBase & { failureKind: string; message?: string },
): Promise<void> {
  await markTaskFailedWithEvent({
    writer: opts.writer,
    taskId: opts.taskId,
    envelope: { ...opts.lineage, taskKind: opts.taskKind },
    failureKind: opts.failureKind,
    ...(opts.message !== undefined && { message: opts.message }),
  });
}

/**
 * The bound-once context the loop-level helpers consume — writer/lineage/taskId
 * built ONCE per loop run, so each terminal site is `markPlannerPassed(ctx)`
 * or `markPlannerFailed(ctx, kind, message?)`. Keeps the loop file lean while the
 * atomic guarantee lives one layer down. taskKind defaults to "plan".
 */
export interface PlannerTerminalContext {
  /** REQUIRED (audit finding H3 sweep — no fallback arm). */
  writer: RunStateWriter;
  taskId: string;
  lineage: PlannerTaskLineage;
}
const PLAN_KIND = "plan";
/** task #46: 1-line call site for the SUCCESS-terminal pair (`task.completed`). */
export async function markPlannerPassed(ctx: PlannerTerminalContext): Promise<void> {
  await markPlannerTaskDoneWithEvent({ ...ctx, taskKind: PLAN_KIND, outcome: "passed" });
}
/** task #46: 1-line call site for the FAILED-terminal pair (`task.failed`). */
export async function markPlannerFailed(
  ctx: PlannerTerminalContext,
  failureKind: string,
  message?: string,
): Promise<void> {
  await markPlannerTaskFailedWithEvent({
    ...ctx,
    taskKind: PLAN_KIND,
    failureKind,
    ...(message !== undefined && { message }),
  });
}
