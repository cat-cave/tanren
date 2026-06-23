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
import { markTaskFailed } from "./subtaskTasks.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Shape of the per-stage `appendEvent` callback the loop threads through every stage. */
type StageAppendEvent = <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;

/** The closed vocabulary the per-stage `task.failed.failureKind` carries. */
export type StageFailureKind = "window_exhausted" | "timeout" | "answerer_schema_invalid" | "crashed";

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
 * Run a stage's answerer/writer body with the apex v51 per-stage emit-on-throw
 * contract. On a throw: classify via {@link classifyStageFailureKind}, mark the
 * stage's task row failed, append `task.failed` against the task id, RE-THROW so
 * the workflow's outer catch (`plannerRun.ts`'s `finalizeWorkflowThrow`) still
 * routes the run-level disposition unchanged. On success, returns the body's
 * value verbatim — the helper adds no other side effects, so every stage's
 * existing `task.completed` / success-event emit stays exactly where it was.
 *
 * This wraps the boilerplate every stage in the subtask loop now carries, so a
 * single try/catch lives here rather than copy-pasted across each stage.
 */
export async function runStageWithEmitOnThrow<T>(opts: {
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
    await markTaskFailed(opts.pool, opts.taskId, failureKind, opts.writer);
    await opts.appendEvent(
      "task.failed",
      { taskKind: opts.taskKind, failureKind, message: stageFailureMessage(error) },
      opts.taskId,
    );
    throw error;
  }
}
