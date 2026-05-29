import type pg from "pg";
import { z } from "zod";
import { ActorKind, type ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// Actor info derived from task rows. Phase 2 does not yet have a dedicated
// actors table; this store gives downstream callers a typed view of the
// agent_kind column without exposing raw SQL row casts.
export const TaskActorRow = z.object({
  taskId: z.string(),
  agentKind: ActorKind,
  cli: z.string(),
  model: z.string().nullable(),
});
export type TaskActorRow = z.infer<typeof TaskActorRow>;

interface RawTaskActorRow {
  task_id: unknown;
  agent_kind: unknown;
  cli: unknown;
  model: unknown;
}

function decodeTaskActorRow(raw: RawTaskActorRow): TaskActorRow {
  return TaskActorRow.parse({
    taskId: raw.task_id,
    agentKind: raw.agent_kind,
    cli: raw.cli,
    model: raw.model,
  });
}

export const ActorStore = {
  async getForTask(client: QueryClient, taskId: string, _actor: ActorRef): Promise<TaskActorRow | undefined> {
    const result = await client.query("SELECT task_id, agent_kind, cli, model FROM tasks WHERE task_id = $1", [taskId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeTaskActorRow(row as RawTaskActorRow);
  },

  async listForRun(client: QueryClient, runId: string, _actor: ActorRef): Promise<TaskActorRow[]> {
    const result = await client.query(
      "SELECT task_id, agent_kind, cli, model FROM tasks WHERE run_id = $1 ORDER BY task_id",
      [runId],
    );
    return result.rows.map((row) => decodeTaskActorRow(row as RawTaskActorRow));
  },
} as const;
