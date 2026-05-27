import type pg from "pg";
import { z } from "zod";
import { ActorKind, type ActorRef } from "../state/actor.js";
import { TaskKind, TaskOutcome, TaskStatus, transitionTask } from "../state/task.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const TaskRow = z.object({
  taskId: z.string(),
  runId: z.string(),
  kind: TaskKind,
  title: z.string(),
  parentTaskId: z.string().nullable(),
  status: TaskStatus,
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  outcome: TaskOutcome.nullable(),
  failureKind: z.string().nullable(),
  agentKind: ActorKind,
  cli: z.string(),
  model: z.string().nullable(),
  attempt: z.number(),
  tenantId: z.string().nullable(),
  userId: z.string().nullable()
});
export type TaskRow = z.infer<typeof TaskRow>;

interface RawTaskRow {
  task_id: unknown;
  run_id: unknown;
  kind: unknown;
  title: unknown;
  parent_task_id: unknown;
  status: unknown;
  started_at: unknown;
  ended_at: unknown;
  outcome: unknown;
  failure_kind: unknown;
  agent_kind: unknown;
  cli: unknown;
  model: unknown;
  attempt: unknown;
  tenant_id: unknown;
  user_id: unknown;
}

const SELECT_TASK_COLUMNS = `
  task_id,
  run_id,
  kind,
  title,
  parent_task_id,
  status,
  started_at,
  ended_at,
  outcome,
  failure_kind,
  agent_kind,
  cli,
  model,
  attempt,
  tenant_id,
  user_id
`;

function decodeTaskRow(raw: RawTaskRow): TaskRow {
  return TaskRow.parse({
    taskId: raw.task_id,
    runId: raw.run_id,
    kind: raw.kind,
    title: raw.title,
    parentTaskId: raw.parent_task_id,
    status: raw.status,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    outcome: raw.outcome,
    failureKind: raw.failure_kind,
    agentKind: raw.agent_kind,
    cli: raw.cli,
    model: raw.model,
    attempt: typeof raw.attempt === "number" ? raw.attempt : Number(raw.attempt),
    tenantId: raw.tenant_id,
    userId: raw.user_id
  });
}

export const TaskStore = {
  async get(client: QueryClient, taskId: string, _actor: ActorRef): Promise<TaskRow | undefined> {
    const result = await client.query(`SELECT ${SELECT_TASK_COLUMNS} FROM tasks WHERE task_id = $1`, [taskId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeTaskRow(row as RawTaskRow);
  },

  async list(
    client: QueryClient,
    filter: { runId?: string; kind?: z.infer<typeof TaskKind>; status?: z.infer<typeof TaskStatus> } | undefined,
    _actor: ActorRef
  ): Promise<TaskRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.runId !== undefined) {
      params.push(filter.runId);
      clauses.push(`run_id = $${params.length}`);
    }
    if (filter?.kind !== undefined) {
      params.push(filter.kind);
      clauses.push(`kind = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const result = await client.query(`SELECT ${SELECT_TASK_COLUMNS} FROM tasks${where} ORDER BY task_id`, params);
    return result.rows.map((row) => decodeTaskRow(row as RawTaskRow));
  },

  async updateStatus(
    client: QueryClient,
    taskId: string,
    next: {
      from: z.infer<typeof TaskStatus>;
      to: z.infer<typeof TaskStatus>;
      outcome?: z.infer<typeof TaskOutcome>;
      failureKind?: string;
      setEndedAt?: boolean;
      setStartedAt?: boolean;
    },
    _actor: ActorRef
  ): Promise<TaskRow> {
    transitionTask(next.from, next.to);
    const sets: string[] = ["status = $2"];
    const params: unknown[] = [taskId, next.to];
    if (next.outcome !== undefined) {
      params.push(next.outcome);
      sets.push(`outcome = $${params.length}`);
    }
    if (next.failureKind !== undefined) {
      params.push(next.failureKind);
      sets.push(`failure_kind = $${params.length}`);
    }
    if (next.setStartedAt === true) {
      sets.push("started_at = COALESCE(started_at, now())");
    }
    if (next.setEndedAt === true) {
      sets.push("ended_at = now()");
    }
    const result = await client.query(
      `UPDATE tasks SET ${sets.join(", ")} WHERE task_id = $1 RETURNING ${SELECT_TASK_COLUMNS}`,
      params
    );
    if (result.rows.length === 0) {
      throw new Error(`task not found: ${taskId}`);
    }
    return decodeTaskRow(result.rows[0] as RawTaskRow);
  }
} as const;
