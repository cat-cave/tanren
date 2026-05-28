// P2A-0012: task-row persistence helpers for the planner-feedback loop.
// Subtasks reuse the existing `tasks` table (Option B in the spec): the
// planner task is the parent and writer/check tasks reference it via
// `parent_task_id`. The existing `attempt` column carries writer-retry
// attempts. No new table is required.
import type pg from "pg";
import type { AnswererAdapter, WriterAdapter } from "../providers/types.js";
import type { PlanAnswer } from "../answerers/schemas/index.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export type ChildTaskKind = "write" | "check" | "audit";

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
  planner: AnswererAdapter<PlanAnswer>
): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, started_at, agent_kind, cli, model)
     VALUES ($1, $2, 'plan', 'plan spec', 'running', now(), 'answerer', $3, NULL)`,
    [taskId, runId, planner.cli]
  );
}

export async function insertChildTask(pool: LoopQueryClient, task: ChildTaskInsert): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, parent_task_id, status, started_at, agent_kind, cli, model)
     VALUES ($1, $2, $3, $4, $5, 'running', now(), $6, $7, $8)`,
    [task.taskId, task.runId, task.kind, task.title, task.parentTaskId, task.agentKind, task.cli, task.model]
  );
}

export async function markTaskDone(
  pool: LoopQueryClient,
  taskId: string,
  outcome: "passed" | "rejected_by_checker" | "rejected_by_auditor"
): Promise<void> {
  await pool.query(
    `UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1`,
    [taskId, outcome]
  );
}

export function writerAdapterRowMeta(writer: WriterAdapter): { cli: string; agentKind: "writer" } {
  return { cli: writer.cli, agentKind: "writer" };
}
