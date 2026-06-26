import type pg from "pg";
import type { EventStore } from "../../eventStore.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { routeTaskUpdate } from "../taskWriteRouting.js";

type TaskQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface MergeTaskTerminalBase {
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
}

export async function markMergeTaskDoneWithEvent(input: {
  writer?: RunStateWriter;
  pool: TaskQueryClient;
  eventStore: EventStore;
  base: MergeTaskTerminalBase;
  integration: string;
}): Promise<void> {
  const { writer, pool, eventStore, base, integration } = input;
  if (writer !== undefined) {
    await writer.updateTaskWithEvent({
      task: { taskId: base.taskId, transition: "done", outcome: "ok" },
      event: {
        ...base,
        eventType: "task.completed",
        payload: { taskKind: "merge", status: integration } as never,
      },
    });
    return;
  }
  await routeTaskUpdate(
    undefined,
    pool,
    { taskId: base.taskId, transition: "done", outcome: "ok" },
    "UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1",
    [base.taskId, "ok"],
  );
  await eventStore.append({
    ...base,
    eventType: "task.completed",
    payload: { taskKind: "merge", status: integration },
  });
}

export async function markMergeTaskFailedWithEvent(input: {
  writer?: RunStateWriter;
  pool: TaskQueryClient;
  eventStore: EventStore;
  base: MergeTaskTerminalBase;
  failureKind: string;
}): Promise<void> {
  const { writer, pool, eventStore, base, failureKind } = input;
  if (writer !== undefined) {
    await writer.updateTaskWithEvent({
      task: { taskId: base.taskId, transition: "failed_with_kind", failureKind },
      event: {
        ...base,
        eventType: "task.failed",
        payload: { taskKind: "merge", failureKind } as never,
      },
    });
    return;
  }
  await routeTaskUpdate(
    undefined,
    pool,
    { taskId: base.taskId, transition: "failed_with_kind", failureKind },
    "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
    [base.taskId, failureKind],
  );
  await eventStore.append({
    ...base,
    eventType: "task.failed",
    payload: { taskKind: "merge", failureKind },
  });
}
