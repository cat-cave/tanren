// the ONE source of truth for the run/spec/task LIFECYCLE write
// SQL. Both the in-process `DirectRunStateWriter` and the control-plane
// `/internal/*` endpoints execute these SAME fixed, parameterized statements, so
// the persisted rows are byte-for-byte identical whichever plane runs them — and
// the endpoint never runs caller-supplied SQL (it maps a structured op to a
// fixed statement here). The strings are byte-identical to the inline `.query`
// the workflow drove before, so the direct path + its mutation suite are
// unchanged.

import type pg from "pg";
import { z } from "zod";
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
  UpdateTaskWithEventInput,
} from "../contracts/runStateWriter.js";
import { PgEventStore } from "../eventStore.js";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
type QueryClient = { query: (text: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> };

/**
 * The TASK-LIFECYCLE atomicity client (task #39): a pg-pool/PoolClient compatible
 * shape so the row-UPDATE applier above + `PgEventStore.append` can share the
 * SAME in-transaction client. `PgEventStore` constructs over this shape, and
 * `applyUpdateTask` only needs `.query`, so both run on the caller's `runWithOrgScope`
 * client and COMMIT atomically — terminal row + terminal `task.*` event live or die
 * together.
 */
type TaskLifecycleClient = Pick<pg.Pool | pg.PoolClient, "query">;

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

/**
 * The outcome of an atomic terminal-row + terminal-event apply (task #40 Class B):
 * tells the caller WHETHER this call's event INSERT landed (`false`) or was
 * deduped against the partial unique index `events_task_terminal_unique` because
 * the original write already landed and was retried after a dropped HTTP
 * response (`true`). Callers that wrap the seam (e.g.
 * `markTaskDoneWithEvent`) treat `alreadyTerminal: true` as a SILENT success
 * (the work is durably done) rather than a throwable error.
 */
export interface UpdateTaskWithEventOutcome {
  /** True when the event was already terminal (this call deduped); false when this call wrote it. */
  alreadyTerminal: boolean;
}

/**
 * The ATOMIC terminal task row + terminal `task.*` event applier (task #39 —
 * critic-arc R2 NEW#1 / R3 BLOCKING: the prior split issued two separate writes,
 * so a crash/DB failure between them stranded the row terminal-`done` with no
 * `task.completed` event — autonomy-engine.md §1c single-finalize invariant
 * violation). Mirrors `applyFinalizeLand` (merge-land's row + `merge.completed`
 * pair): runs ONE row UPDATE + ONE event INSERT on the SAME caller-supplied
 * client, so both COMMIT together. The notify wake (`tanren_run`, `tanren_event`)
 * fires at COMMIT — exactly when the row + event are durable. The caller owns
 * the org scope (`runWithOrgScope`).
 *
 * The pairing constraint is enforced at the seam by `terminalPairSchema`
 * (in `contracts/runStateWriter.ts`): only the terminal task transitions
 * (`done` / `failed*`) pair with the matching terminal event types
 * (`task.completed` / `task.failed`), so a misuse cannot route a non-terminal
 * transition through the atomic seam (and a `running` row update + a
 * `task.completed` event is rejected before any DB I/O).
 *
 * IDEMPOTENT TERMINAL EVENT INSERT (task #40 Class B — RPC phantom-write
 * idempotency): the row UPDATE has always been idempotent (the guarded
 * `WHERE status='running'` transitions are no-op on an already-terminal row);
 * the event INSERT now is too. The terminal `task.*` event INSERTs through
 * `PgEventStore.appendIfAbsent`, which is `ON CONFLICT DO NOTHING` against the
 * partial unique index `events_task_terminal_unique` (task_id, event_type) —
 * so a server-side COMMIT whose HTTP response was DROPPED + a data-plane
 * retry (the writer call throws `RunStateWriteTransportError` → bubbles into
 * the finalize-guard catch → fires `markTaskFailedIfRunningWithEvent`) sees
 * the original event already landed, returns `alreadyTerminal: true`, and
 * does NOT contradict the timeline with a second same-type terminal event.
 * Returns the outcome so the caller (the HTTP route + the wrapping helpers)
 * surfaces the distinction (HTTP route: 200 vs 204; helpers: silent swallow).
 */
export async function applyUpdateTaskWithEvent(
  client: TaskLifecycleClient,
  input: UpdateTaskWithEventInput,
): Promise<UpdateTaskWithEventOutcome> {
  await applyUpdateTask(client, input.task);
  const inserted = await new PgEventStore(client).appendIfAbsent(input.event);
  return { alreadyTerminal: !inserted };
}

// --- Terminal row + event PAIRING schema (task #39) -------------------------
//
// The atomic seam (`applyUpdateTaskWithEvent` + the internal HTTP endpoint + the
// `RunStateWriter.updateTaskWithEvent` impls) is RESTRICTED to TERMINAL
// transitions paired with their matching `task.*` event. A non-terminal
// transition (e.g. `running`, `running_pending`) MUST NOT route through this
// seam — only the row + the terminal event are durable together; a non-terminal
// pair would imply a phantom `task.completed` against a still-running row.
// Similarly, a mismatched pair (e.g. `done` ↔ `task.failed`) is a wiring bug
// the seam rejects BEFORE any DB I/O, so a misuse is caught loud at the boundary.

/** The closed set of TERMINAL task transitions the atomic seam admits. */
const TERMINAL_TASK_TRANSITIONS = ["done", "failed", "failed_with_kind", "failed_with_kind_if_running"] as const;
type TerminalTaskTransition = (typeof TERMINAL_TASK_TRANSITIONS)[number];

/** The closed set of TERMINAL task events the atomic seam admits. */
const TERMINAL_TASK_EVENT_TYPES = ["task.completed", "task.failed"] as const;
type TerminalTaskEventType = (typeof TERMINAL_TASK_EVENT_TYPES)[number];

/** Map a terminal transition to the matching event type (the pairing constraint). */
function expectedEventTypeFor(transition: TerminalTaskTransition): TerminalTaskEventType {
  // `done` is the success terminal → `task.completed`. Every `failed*` variant
  // (hard failure / failed-with-kind / the guarded failed-if-running) is the
  // failure terminal → `task.failed`.
  return transition === "done" ? "task.completed" : "task.failed";
}

/**
 * Zod refinement for {@link UpdateTaskWithEventInput}: only terminal transitions
 * + matching terminal event types pass. A non-terminal transition or a
 * mismatched (e.g. `done` ↔ `task.failed`) pair is rejected at the seam BEFORE
 * any DB I/O — the atomic primitive REQUIRES a terminal-+-matching shape, and
 * a misuse must fail loud rather than persist a half-baked write. The internal
 * write endpoint runs this on the parsed body; the in-process direct writer
 * runs it inside `updateTaskWithEvent` so both planes share the same guard.
 *
 * The two task-input fields (`taskId`, `transition`) are validated explicitly,
 * the rest of the row UPDATE shape (`outcome`, `failureKind`, `attempt`,
 * `orgId`) is passed through as-is to {@link applyUpdateTask}, which itself
 * branches on the transition. The event side validates the type vocabulary
 * (the pairing constraint); the event payload is parsed by `PgEventStore.append`
 * against the {@link EventRegistry}, so a malformed payload throws at the
 * append (the existing event-validation contract is unchanged).
 */
export const terminalPairSchema = z
  .object({
    task: z
      .object({
        taskId: z.string().min(1),
        // The row UPDATE accepts only the four terminal transitions on this seam.
        transition: z.enum(TERMINAL_TASK_TRANSITIONS),
        orgId: z.string().min(1).optional(),
        outcome: z.string().min(1).optional(),
        failureKind: z.string().min(1).optional(),
        attempt: z.number().int().optional(),
      })
      .strict(),
    event: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().min(1).optional(),
        projectId: z.string().min(1),
        eventType: z.enum(TERMINAL_TASK_EVENT_TYPES),
        // The payload is parsed downstream by `PgEventStore.append` against the
        // event-registry schema for the named type — keep it permissive here
        // so the type-specific decode lives in ONE place (the event store).
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict()
  .refine((value) => expectedEventTypeFor(value.task.transition) === value.event.eventType, {
    error:
      "terminal-pair mismatch: transition must pair with the matching task event type (done → task.completed; failed* → task.failed)",
    path: ["event", "eventType"],
  });

// Task #48 atomic seams: `applyFinalizeRunWithEvent` / `applyUpdateSpecWithEvent`
// + their `runPairSchema` / `specPairSchema` live in `./runStateAtomicSql.ts`
// (the 500-line cap keeps this file lean; re-exported here so callers see one namespace).
export {
  applyFinalizeRunWithEvent,
  applyUpdateSpecWithEvent,
  runPairSchema,
  specPairSchema,
} from "./runStateAtomicSql.js";
