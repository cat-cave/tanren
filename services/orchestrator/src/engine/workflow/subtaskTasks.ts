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
