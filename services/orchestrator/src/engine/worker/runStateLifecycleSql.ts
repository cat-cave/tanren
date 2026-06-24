// the ONE source of truth for the run/spec/task LIFECYCLE write
// SQL. Both the in-process `DirectRunStateWriter` and the control-plane
// `/internal/*` endpoints execute these SAME fixed, parameterized statements, so
// the persisted rows are byte-for-byte identical whichever plane runs them — and
// the endpoint never runs caller-supplied SQL (it maps a structured op to a
// fixed statement here). The strings are byte-identical to the inline `.query`
// the workflow drove before, so the direct path + its mutation suite are
// unchanged.

import type {
  ClearRunPercolationPendingInput,
  InsertTaskInput,
  MergeRunVerifiedAncestorShaInput,
  SetRunAuthRefInput,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
  UpdateTaskInput,
} from "../contracts/runStateWriter.js";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
type QueryClient = { query: (text: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> };

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

/**
 * Stamp `runs.auth_ref` (subtask-accounting concurrent-credential dedup). Idempotent —
 * `WHERE auth_ref IS DISTINCT FROM $2` makes a re-stamp of the same value a no-op. The
 * string is byte-identical to the inline `stampRunAuthRef` UPDATE.
 */
export async function applySetRunAuthRef(client: QueryClient, input: SetRunAuthRefInput): Promise<void> {
  await client.query("UPDATE runs SET auth_ref = $2 WHERE run_id = $1 AND auth_ref IS DISTINCT FROM $2", [
    input.runId,
    input.authRef,
  ]);
}

/** The `UPDATE specs SET status` (`in_flight` / merge-outcome). */
export async function applySetSpecStatus(client: QueryClient, input: SetSpecStatusInput): Promise<void> {
  // Optional idempotency guard (the merge coordinator's `merged` finalize + reopen):
  // `WHERE status <> ALL($3)` so a spec already in a terminal-good state is not
  // clobbered. Omitted ⇒ the unguarded set (the workflow's `in_flight`), unchanged.
  if (input.notFromStatuses !== undefined && input.notFromStatuses.length > 0) {
    await client.query("UPDATE specs SET status = $2 WHERE spec_id = $1 AND status <> ALL($3::text[])", [
      input.specId,
      input.status,
      input.notFromStatuses,
    ]);
    return;
  }
  await client.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [input.specId, input.status]);
}

/** The `UPDATE specs SET metadata` (the intake's discovery-provenance stamp). */
export async function applySetSpecMetadata(client: QueryClient, input: SetSpecMetadataInput): Promise<void> {
  await client.query("UPDATE specs SET metadata = $2::jsonb WHERE spec_id = $1", [input.specId, input.metadataJson]);
}

// --- Change-percolation (§2c) run-column writes — byte-identical to the inline SQL. ---

/**
 * Re-point a speculative run's dynamic base to the re-resolved ANCESTOR STACK (the
 * never-discard base-shift re-point). jj-local: the base shift writes ONLY
 * `runs.ancestor_stack` — the ordered stack is the sole base truth (jj-local has no
 * synthesized host ref; the legacy `speculative_base` column was dropped in WS-B PR-12).
 */
export async function applySetRunSpeculativeBase(
  client: QueryClient,
  input: SetRunSpeculativeBaseInput,
): Promise<void> {
  await client.query("UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1", [
    input.runId,
    input.ancestorStack === undefined ? null : JSON.stringify(input.ancestorStack),
  ]);
}

/** Stamp the percolation re-execution run id onto the dependent's in-flight marker. */
export async function applySetRunPercolationReexecId(
  client: QueryClient,
  input: SetRunPercolationReexecIdInput,
): Promise<void> {
  await client.query(
    `UPDATE runs
        SET percolation_pending = COALESCE(percolation_pending, '{}'::jsonb) || jsonb_build_object('reexecRunId', $2::text)
      WHERE run_id = $1`,
    [input.runId, input.reexecRunId],
  );
}

/** Clear the in-flight percolation marker once a percolation settled. */
export async function applyClearRunPercolationPending(
  client: QueryClient,
  input: ClearRunPercolationPendingInput,
): Promise<void> {
  await client.query("UPDATE runs SET percolation_pending = NULL WHERE run_id = $1", [input.runId]);
}

/** Merge ONE ancestor's absorbed SHA + verdict into `verified_ancestor_shas`. */
export async function applyMergeRunVerifiedAncestorSha(
  client: QueryClient,
  input: MergeRunVerifiedAncestorShaInput,
): Promise<void> {
  await client.query(
    `UPDATE runs
        SET verified_ancestor_shas =
          COALESCE(verified_ancestor_shas, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
      WHERE run_id = $1`,
    [input.runId, input.ancestorSpecId, input.entryJson],
  );
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
        "UPDATE tasks SET status = 'running', outcome = NULL, failure_kind = NULL, started_at = COALESCE(started_at, now()), ended_at = NULL WHERE task_id = $1",
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
    case "failed_with_kind_if_running":
      // The finalize-guard idempotency primitive: a POST-success throw (e.g. the
      // cost recorder fails AFTER the provider call already wrote its result) must
      // not clobber a row a clean branch already moved to `done`. The
      // `WHERE status='running'` guard makes a re-run a no-op when the row is
      // already terminal — same fixed UPDATE shape as `failed_with_kind`, plus the
      // single AND clause. See `subtaskTasks.ts:markTaskFailedIfRunning`.
      await client.query(
        "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1 AND status = 'running'",
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
