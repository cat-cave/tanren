// Plane-split P3c: the shared TASK-write routing seam for the workflow stages.
// Mirrors `buildFinalizeRunState`'s pattern — a single helper that runs the
// structured remote op through the `RunStateWriter` when one is wired
// (remote-writes on), else the byte-identical in-process `direct` write on the
// pool. Centralizing it keeps the CI / review / merge stages compact (and under
// the 500-line cap) and gives the `tasks` lifecycle one routing point.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RunStateWriter, UpdateTaskInput } from "../contracts/runStateWriter.js";

type TaskQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The fixed shape of a SYSTEM task (CI / review / merge): `agent_kind='system'`, `cli='github'`. */
export interface SystemTaskSpec {
  runId: string;
  /** The task `kind` (`ci` / `review` / `merge`). */
  kind: string;
  /** The task `title`. */
  title: string;
}

/**
 * Ensure the single SYSTEM task for a run⋈kind exists and is `running`, returning
 * its id. Re-running re-opens the latest row (status `running`, `ended_at` NULL);
 * the first run inserts it (attempt 1). The SELECT is a READ (the data plane
 * keeps `tasks` SELECT); only the INSERT/UPDATE route through `writer` when wired
 * (remote-writes on) — else the byte-identical in-process write on `pool`.
 * Shared by the CI / review / merge stages so the ensure-task shape lives once.
 */
export async function ensureSystemTask(
  pool: TaskQueryClient,
  spec: SystemTaskSpec,
  writer?: RunStateWriter,
): Promise<string> {
  const existing = await pool.query(
    `SELECT task_id FROM tasks WHERE run_id = $1 AND kind = $2 ORDER BY started_at DESC NULLS LAST, task_id ASC LIMIT 1`,
    [spec.runId, spec.kind],
  );
  const existingTask = existing.rows[0] as { task_id: string } | undefined;
  if (existingTask !== undefined) {
    await routeTaskUpdate(
      writer,
      pool,
      { taskId: existingTask.task_id, transition: "running" },
      "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), ended_at = NULL WHERE task_id = $1",
      [existingTask.task_id],
    );
    return existingTask.task_id;
  }
  const taskId = `task_${randomUUID()}`;
  if (writer === undefined) {
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model, attempt)
       VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), $3, $4, 'running', now(), 'system', 'github', NULL, 1)`,
      [taskId, spec.runId, spec.kind, spec.title],
    );
  } else {
    await writer.insertTask({
      taskId,
      runId: spec.runId,
      kind: spec.kind,
      title: spec.title,
      status: "running",
      agentKind: "system",
      cli: "github",
      model: null,
      setStartedAt: true,
      attempt: 1,
    });
  }
  return taskId;
}

/**
 * Apply one `tasks` UPDATE: through the control-plane endpoint when `writer` is
 * wired, else the byte-identical in-process `directSql`/`directParams` on `pool`.
 * The remote `op` and the direct SQL persist the SAME row — only WHERE the
 * statement runs differs.
 */
export async function routeTaskUpdate(
  writer: RunStateWriter | undefined,
  pool: TaskQueryClient,
  op: UpdateTaskInput,
  directSql: string,
  directParams: unknown[],
): Promise<void> {
  if (writer === undefined) {
    await pool.query(directSql, directParams);
    return;
  }
  await writer.updateTask(op);
}
