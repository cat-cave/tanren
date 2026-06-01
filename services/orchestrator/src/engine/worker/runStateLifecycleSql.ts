// Plane-split P3c: the ONE source of truth for the run/spec/task LIFECYCLE write
// SQL. Both the in-process `DirectRunStateWriter` and the control-plane
// `/internal/*` endpoints execute these SAME fixed, parameterized statements, so
// the persisted rows are byte-for-byte identical whichever plane runs them — and
// the endpoint never runs caller-supplied SQL (it maps a structured op to a
// fixed statement here). The strings are byte-identical to the inline `.query`
// the workflow drove before P3c, so the direct path + its mutation suite are
// unchanged.

import type {
  InsertTaskInput,
  SetRunPrUrlInput,
  SetRunStatusInput,
  SetSpecStatusInput,
  UpdateTaskInput,
} from "../contracts/runStateWriter.js";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
type QueryClient = { query: (text: string, params?: unknown[]) => Promise<unknown> };

/** The non-finalize `UPDATE runs` (the `running` transition). */
export async function applySetRunStatus(client: QueryClient, input: SetRunStatusInput): Promise<void> {
  const sql = input.setStartedAt
    ? "UPDATE runs SET status = $2, started_at = now() WHERE run_id = $1"
    : "UPDATE runs SET status = $2 WHERE run_id = $1";
  await client.query(sql, [input.runId, input.status]);
}

/** The `UPDATE runs SET pr_url` after the draft PR is opened. */
export async function applySetRunPrUrl(client: QueryClient, input: SetRunPrUrlInput): Promise<void> {
  await client.query("UPDATE runs SET pr_url = $2 WHERE run_id = $1", [input.runId, input.prUrl]);
}

/** The `UPDATE specs SET status` (`in_flight` / merge-outcome). */
export async function applySetSpecStatus(client: QueryClient, input: SetSpecStatusInput): Promise<void> {
  await client.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [input.specId, input.status]);
}

/** Cancel the vestigial queued `plan` task the spec-run trigger pre-created. */
export async function applySupersedeQueuedPlannerTask(client: QueryClient, runId: string): Promise<void> {
  await client.query(
    "UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'",
    [runId],
  );
}

/** Insert one `tasks` row — org from the row's run (`(SELECT org_id FROM runs …)`). */
export async function applyInsertTask(client: QueryClient, input: InsertTaskInput): Promise<void> {
  const started = input.setStartedAt ? "now()" : "NULL";
  const cols = ["task_id", "run_id", "org_id", "kind", "title"];
  const vals = ["$1", "$2", "(SELECT org_id FROM runs WHERE run_id = $2)", "$3", "$4"];
  const params: unknown[] = [input.taskId, input.runId, input.kind, input.title];
  let next = 5;
  if (input.parentTaskId !== undefined) {
    cols.push("parent_task_id");
    vals.push(`$${next}`);
    params.push(input.parentTaskId);
    next += 1;
  }
  cols.push("status", "started_at", "agent_kind", "cli", "model");
  vals.push(`$${next}`, started, `$${next + 1}`, `$${next + 2}`, `$${next + 3}`);
  params.push(input.status, input.agentKind, input.cli, input.model);
  next += 4;
  if (input.attempt !== undefined) {
    cols.push("attempt");
    vals.push(`$${next}`);
    params.push(input.attempt);
  }
  await client.query(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${vals.join(", ")})`, params);
}

/** Move one `tasks` row through a named lifecycle transition by `task_id`. */
export async function applyUpdateTask(client: QueryClient, input: UpdateTaskInput): Promise<void> {
  switch (input.transition) {
    case "running":
      await client.query(
        "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), ended_at = NULL WHERE task_id = $1",
        [input.taskId],
      );
      return;
    case "running_attempt":
      await client.query(
        "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), attempt = $2 WHERE task_id = $1",
        [input.taskId, input.attempt],
      );
      return;
    case "running_pending":
      await client.query(
        "UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL WHERE task_id = $1",
        [input.taskId],
      );
      return;
    case "running_pending_clear_failure":
      await client.query(
        "UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL, failure_kind = NULL WHERE task_id = $1",
        [input.taskId],
      );
      return;
    case "started":
      await client.query("UPDATE tasks SET status = 'running', started_at = now() WHERE task_id = $1", [input.taskId]);
      return;
    case "done":
      await client.query("UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1", [
        input.taskId,
        input.outcome,
      ]);
      return;
    case "failed":
      await client.query(
        "UPDATE tasks SET status = 'failed', outcome = 'failed', ended_at = now() WHERE task_id = $1",
        [input.taskId],
      );
      return;
    case "failed_with_kind":
      await client.query(
        "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
        [input.taskId, input.failureKind],
      );
      return;
    case "cancelled":
      await client.query(
        "UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE task_id = $1",
        [input.taskId],
      );
  }
}
