// SHARED stage-throw classifier for the per-stage `task.failed` emit-on-throw
// (timeout-eradication.md §1 disguised-survivor family — apex v51 finding).
//
// Every stage in the subtask loop (planner, writer, checker, auditor, triage,
// convergence, demo-run, design-oracle) wraps its answerer/writer call in a
// try/catch that emits a TERMINAL `task.failed` event against the stage's
// `task_id` BEFORE re-throwing into the workflow's run-level catch
// (`plannerRun.ts`'s `finalizeWorkflowThrow`). The run/spec/runner events
// already ride loud at the RUN granularity; without this emit the per-task
// row stays `running` forever with no `task.failed` event — loud at one
// granularity, silent at another (the #640 family).
//
// `classifyStageFailureKind` maps the caught error CLASS into the closed
// `task.failed.failureKind` vocabulary the writer-stage already uses
// (`window_exhausted` / `timeout` / `crashed`), plus the auditor's
// `answerer_schema_invalid` for a parse miss. An unrecognized error falls
// CLOSED to `crashed` (the writer-stage's existing default).

import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { EventName, EventPayload } from "../events/index.js";
import { AnswererSchemaValidationError, AnswererStalledError } from "../providers/answererSchemaError.js";
import { CodexUsageLimitError } from "../providers/codex.js";
import { ClaudeUsageLimitError } from "../providers/claude.js";
import { StageStallEscalationError } from "./loopStageRecovery.js";
import { markTaskFailedIfRunning } from "./subtaskTasks.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Shape of the per-stage `appendEvent` callback the loop threads through every stage. */
export type StageAppendEvent = <N extends EventName>(
  eventType: N,
  payload: EventPayload<N>,
  taskId?: string,
) => Promise<void>;

/** The closed vocabulary the per-stage `task.failed.failureKind` carries. */
export type StageFailureKind =
  | "window_exhausted"
  | "timeout"
  | "answerer_schema_invalid"
  | "cost_record_failed"
  | "event_append_failed"
  | "crashed";

/**
 * The cost-recorder THROW wrapper (task #35 — critic-arc R1 #6 / R2). When
 * `recordWriterCost` / `recordAnswererCost` re-throws an error surfacing from the
 * underlying `CostRecorder.record(...)` INSERT (DB transport / RLS / schema), the
 * subtaskCost helpers RE-RAISE it as this typed wrapper class so the finalize
 * guard's classifier maps it deterministically to `failureKind: "cost_record_failed"`
 * — rather than landing in the fail-closed `crashed` default that swallows the
 * mid-stage cost-recorder family in apex tier-1.
 */
export class CostRecordError extends Error {
  override readonly cause?: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "cost record write failed");
    this.name = "CostRecordError";
    this.cause = cause;
  }
}

/**
 * The event-append THROW wrapper (task #35 — critic-arc R1 #6 / R2). When the
 * finalize guard catches an unclassified throw from a stage's PRE-TERMINAL event
 * append (e.g. `checker.verdict`, `writer.subtask.completed`), it would otherwise
 * be classified as `crashed`. Stages that wrap their pre-terminal appends in
 * `wrapEventAppend` re-throw as this wrapper so the guard surfaces
 * `failureKind: "event_append_failed"` — distinct + searchable on the timeline.
 */
export class EventAppendError extends Error {
  override readonly cause?: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "event append failed");
    this.name = "EventAppendError";
    this.cause = cause;
  }
}

/**
 * Classify a caught stage error into the `task.failed.failureKind` vocabulary
 * the writer-stage's existing branches already use. Keys off the error CLASS
 * (`instanceof`), NEVER the error message — a novel secret shape in the message
 * can never widen what's published on the timeline. An unrecognized error falls
 * CLOSED to `crashed`.
 *
 * - `CodexUsageLimitError` / `ClaudeUsageLimitError` → `window_exhausted`
 *   (the §4.3 authenticated-but-out-of-quota window pressure)
 * - `AnswererStalledError` / `StageStallEscalationError` → `timeout`
 *   (a transient or proven-wedged sign-of-life stall)
 * - `AnswererSchemaValidationError` → `answerer_schema_invalid`
 *   (mirrors the auditor's `auditor_schema_invalid` naming)
 * - `CostRecordError` → `cost_record_failed`
 *   (task #35 — the recorder's DB INSERT failed mid-stage; without this it
 *   would land as `crashed` and the row would strand `running`)
 * - `EventAppendError` → `event_append_failed`
 *   (task #35 — a pre-terminal event append failed mid-stage)
 * - default → `crashed` (the writer-stage's existing default for an unclassified throw)
 */
export function classifyStageFailureKind(error: unknown): StageFailureKind {
  if (error instanceof CodexUsageLimitError || error instanceof ClaudeUsageLimitError) {
    return "window_exhausted";
  }
  if (error instanceof AnswererStalledError || error instanceof StageStallEscalationError) {
    return "timeout";
  }
  if (error instanceof AnswererSchemaValidationError) {
    return "answerer_schema_invalid";
  }
  if (error instanceof CostRecordError) {
    return "cost_record_failed";
  }
  if (error instanceof EventAppendError) {
    return "event_append_failed";
  }
  return "crashed";
}

/**
 * Safe message extraction for the `task.failed.message` payload field. Always
 * returns a non-empty string — an unknown / non-Error throw yields a fixed
 * fallback so the payload is well-formed even on a pathological throw.
 */
export function stageFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "stage threw a non-Error / empty-message failure";
}

/**
 * The WIDER finalize guard (task #35 — critic-arc R1 #6 / R2). Wraps the WHOLE
 * post-insert stage body — provider call + cost record + terminal row update + the
 * terminal `task.*` event — so a throw ANYWHERE in that chain closes the task row
 * loud + emits exactly one `task.failed` event. The PR #665 apex v51 helper
 * `runStageWithEmitOnThrow` only covered the provider body; a recorder throw
 * mid-stage still stranded the row in `status='running'` forever with no
 * `task.failed` event. This helper SUPERSEDES the v51 wrapper and is now the
 * sole call site for the per-stage finalize-on-throw contract. The classifier
 * distinguishes the new mid-stage failure shapes:
 *
 *   - `CostRecordError` → `failureKind: "cost_record_failed"` (the recorder's
 *     DB INSERT failed AFTER a successful provider call)
 *   - `EventAppendError` → `failureKind: "event_append_failed"` (a pre-terminal
 *     event append failed)
 *
 * IDEMPOTENCY (the single-finalize invariant — `autonomy-engine.md` §1c): the row
 * UPDATE is `markTaskFailedIfRunning`, a guarded `WHERE status='running'`. A
 * clean branch that already moved the row to `done` then threw on the `task.completed`
 * event append leaves the existing `done` row alone — the loud signal is the
 * emitted `task.failed` event, not a clobbered terminal row. A re-run of the
 * guard's catch on a row already moved to `failed` is also a no-op for the same
 * reason. The `task.failed` event lands EVERY time (the timeline carries the
 * outage signal even when the row was already terminal).
 */
export async function runStageBodyWithFinalizeGuard<T>(opts: {
  pool: LoopQueryClient;
  writer?: RunStateWriter;
  appendEvent: StageAppendEvent;
  taskId: string;
  taskKind: string;
  body: () => Promise<T>;
}): Promise<T> {
  try {
    return await opts.body();
  } catch (error) {
    const failureKind = classifyStageFailureKind(error);
    await markTaskFailedIfRunning(opts.pool, opts.taskId, failureKind, opts.writer);
    await opts.appendEvent(
      "task.failed",
      { taskKind: opts.taskKind, failureKind, message: stageFailureMessage(error) },
      opts.taskId,
    );
    throw error;
  }
}

/**
 * Wrap a pre-terminal event-append in `EventAppendError` so a throw lands as the
 * deterministic `failureKind: "event_append_failed"` rather than the fail-closed
 * `crashed` default. Use INSIDE a `runStageBodyWithFinalizeGuard` body for any
 * pre-terminal append (e.g. `checker.verdict`, `writer.subtask.completed`,
 * `auditor.verdict`); the matching post-terminal append (`task.completed`) is the
 * guard's responsibility to surface, not a wrapped pre-terminal step.
 */
export async function wrapEventAppend(append: () => Promise<void>): Promise<void> {
  try {
    await append();
  } catch (error) {
    throw new EventAppendError(error);
  }
}
