// The WRITER stage of the spec-implementation loop, split out of `subtaskStages.ts`
// to keep both modules under the 500-line architecture cap (same split shape as the
// `auditorStage.ts` extraction). Owns the single writer invocation per subtask: the
// task row INSERT, the `task.started` + `writer.subtask.started` events, the writer
// call itself (with apex v51 per-stage `task.failed` emit-on-throw wrapping the
// setup-path throw surface), the cost record, and the exit-reason branch
// (`window_exhausted` / `crashed` / `timeout` / `completed` / `token_limit`) that
// routes a non-`completed` writer to a typed FAILED task — never laundered into a
// passed task whose partial/empty diff flows downstream as a success.

import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { PlanSubtask } from "../answerers/schemas/index.js";
import { emitStageTiming } from "../observability/index.js";
import type { WriterAdapter, WriterResult } from "../providers/types.js";
import { recordWriterCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { runStageBodyWithFinalizeGuard, wrapEventAppend } from "./stageFailureKind.js";
import { insertChildTask, markTaskDone, markTaskFailed } from "./subtaskTasks.js";
import type { StageAppendEvent } from "./subtaskStages.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface WriterStageInput {
  pool: LoopQueryClient;
  /** route the writer task INSERT/UPDATE remote when wired. */
  writer?: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: WriterAdapter;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  subtask: PlanSubtask;
  writeTaskId: string;
  prompt: string;
  // The run's BASE sha (clone point), captured once after the workspace clone.
  // Threaded to the writer so it diffs the workspace against the run base —
  // judging each subtask on the CUMULATIVE state, not the per-subtask HEAD
  // delta (so replanned already-done work isn't false-rejected as an empty
  // diff). Omitted by unit callers that drive the stage without a base sha.
  baseSha?: string;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: {
    subtaskTaskId: string;
    subtaskIndex: number;
    attempt: number;
    writer: WriterResult;
  }) => Record<string, unknown>;
}

// The classified result of a writer subtask call. The provider adapters carefully
// classify each run via `WriterResult.exitReason`; this is where that signal is
// READ and routed. A non-`completed` writer must NEVER be laundered into a passed
// task whose partial/empty diff flows downstream as a success:
//   - `completed` / `token_limit` → the task passes; the diff is consumed (the
//     existing semantics — `token_limit` is a clean stop with usable output).
//   - `window_exhausted` → the subscription window is spent mid-call (an expected,
//     RECOVERABLE §4.3 condition); the loop halts the run as window pressure.
//   - `crashed` / `timeout` → a hard, typed failure routed back through the
//     planner-rework/retry-budget path; the task row lands `failed`, not `passed`.
export type WriterStageOutcome =
  | { kind: "completed"; writer: WriterResult }
  | { kind: "window_exhausted"; writer: WriterResult }
  | { kind: "failed"; writer: WriterResult; failureKind: "crashed" | "timeout" };

export async function runWriterStage(args: WriterStageInput): Promise<WriterStageOutcome> {
  await insertChildTask(
    args.pool,
    {
      taskId: args.writeTaskId,
      runId: args.runId,
      kind: "write",
      title: `write subtask ${args.subtask.index}: ${args.subtask.title}`,
      parentTaskId: args.plannerTaskId,
      agentKind: "writer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "write" }, args.writeTaskId);
  await args.appendEvent(
    "writer.subtask.started",
    {
      runId: args.runId,
      taskId: args.writeTaskId,
      subtaskIndex: args.subtask.index,
      intent: args.subtask.intent,
      behaviorIds: [...args.subtask.behaviorIds],
    },
    args.writeTaskId,
  );
  // WIDER FINALIZE GUARD (task #35 — critic-arc R1 #6 / R2): wrap the WHOLE
  // post-insert body — provider call + cost record + terminal row + terminal
  // event — so a throw ANYWHERE (provider setup, cost recorder, event append)
  // closes the row loud + emits exactly one `task.failed`. This SUPERSEDES the
  // inner `runStageWithEmitOnThrow` apex v51 wrap (it only covered the provider
  // body — a recorder throw still stranded the row in `running`).
  return await runStageBodyWithFinalizeGuard({
    pool: args.pool,
    writer: args.writer,
    appendEvent: args.appendEvent,
    taskId: args.writeTaskId,
    taskKind: "write",
    body: () => runWriterStageBody(args),
  });
}

async function runWriterStageBody(args: WriterStageInput): Promise<WriterStageOutcome> {
  const startedAt = Date.now();
  const writerResult = await args.adapter.runWriter({
    prompt: args.prompt,
    workspace: args.workspacePath,
    baseSha: args.baseSha,
    // CROSS-LAYER sign-of-life bridge (task #24, apex v52/v53). On every probe
    // tick the SSH ActivityWatchdog reads the work signature as advancing, emit a
    // `writer.subtask.progress` row — the #21B child-run progress breaker's
    // allowlist includes `writer.%` so this keeps the breaker streak alive on a
    // legitimately slow writer turn whose work signature briefly plateaus mid-
    // IO-burst (a `pnpm install` window). Fire-and-forget `void` because
    // `onProgress` is synchronous (the substrate already catches any throw, but
    // we double-defend here — a rejected appendEvent must not bubble back into
    // the watchdog tick).
    onWatchdogProgress: (signal) => {
      void args
        .appendEvent(
          "writer.subtask.progress",
          {
            runId: args.runId,
            taskId: args.writeTaskId,
            subtaskIndex: args.subtask.index,
            intent: args.subtask.intent,
            outputBytesAdvanced: signal.outputBytesAdvanced,
            ...(signal.workspaceSignature === undefined ? {} : { workspaceSignature: signal.workspaceSignature }),
          },
          args.writeTaskId,
        )
        .catch(() => {
          // appendEvent failure must not bubble into the watchdog tick.
        });
    },
  });
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("write", Date.now() - startedAt, {
    runId: args.runId,
    subtaskIndex: args.subtask.index,
  });
  // The cost is recorded for EVERY outcome — a crashed / timed-out / window-
  // exhausted writer still consumed real tokens. The success event
  // (`writer.subtask.completed`) is emitted ONLY on the success branch below, so
  // a non-completing writer never claims completion. A throw from the recorder is
  // RE-RAISED as CostRecordError by recordWriterCost — the outer guard catches it
  // and routes `failureKind: "cost_record_failed"`.
  await recordWriterCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    taskId: args.writeTaskId,
    runtimeSeconds,
    tokenUsage: writerResult.tokenUsage,
    rawUsage: args.buildUsage?.({
      subtaskTaskId: args.writeTaskId,
      subtaskIndex: args.subtask.index,
      attempt: 1,
      writer: writerResult,
    }) ?? { role: "writer", attempt: 1, subtaskIndex: args.subtask.index },
    // Gates `usage.token_accounting_failed` in recordWriterCost — a TERMINATED
    // writer is already loud via `writer.subtask.failed` (apex v50 fix B1).
    exitReason: writerResult.exitReason,
  });

  // Branch on how the writer actually exited (provider adapters classify this
  // via `exitReason`; read it HERE so a non-`completed` run never reaches the
  // checker as a passed task with a partial/empty diff). The cost above is
  // recorded for every outcome — the work consumed real tokens regardless.
  const exitReason = writerResult.exitReason;
  if (exitReason === "window_exhausted") {
    // §4.3 window pressure surfaced MID-CALL (not just by the pre-flight probe):
    // the task did NOT complete its subtask. Mark it failed (window_exhausted)
    // and emit the failed event; the loop halts the run as recoverable window
    // pressure. Never `passed`.
    await markTaskFailed(args.pool, args.writeTaskId, "window_exhausted", args.writer);
    await emitWriterSubtaskFailed(args, "window_exhausted", "writer usage window exhausted mid-subtask");
    await args.appendEvent("task.failed", { taskKind: "write", failureKind: "window_exhausted" }, args.writeTaskId);
    return { kind: "window_exhausted", writer: writerResult };
  }
  if (exitReason === "crashed" || exitReason === "timeout") {
    // The writer crashed or timed out before finishing: its diff is partial or
    // empty and must NOT be handed to the checker as a success. Fail the task
    // with the typed kind; the loop routes it through the planner-rework path
    // (or exhausts the retry budget) — a loud, recoverable halt.
    const message =
      exitReason === "timeout" ? "writer timed out before completing the subtask" : "writer crashed mid-subtask";
    await markTaskFailed(args.pool, args.writeTaskId, exitReason, args.writer);
    await emitWriterSubtaskFailed(args, exitReason, message);
    await args.appendEvent("task.failed", { taskKind: "write", failureKind: exitReason }, args.writeTaskId);
    return { kind: "failed", writer: writerResult, failureKind: exitReason };
  }
  // `completed` / `token_limit`: the diff is usable, mark the task passed and
  // emit the success event (the writer genuinely produced its subtask output).
  // The PRE-TERMINAL `writer.subtask.completed` append is wrapped so a transport
  // throw lands as `event_append_failed` rather than the fail-closed `crashed`.
  // The post-terminal `task.completed` is left bare: a throw there is the guard's
  // domain (markTaskFailedIfRunning leaves the already-`done` row alone, the
  // `task.failed` event is the loud signal — single-finalize invariant).
  await wrapEventAppend(() =>
    args.appendEvent(
      "writer.subtask.completed",
      {
        runId: args.runId,
        taskId: args.writeTaskId,
        subtaskIndex: args.subtask.index,
        intent: args.subtask.intent,
        decisions: [],
        toolCalls: [],
        diffBytes: Buffer.byteLength(writerResult.diff, "utf8"),
        commitSha: writerResult.commits[0]?.sha ?? null,
      },
      args.writeTaskId,
    ),
  );
  await markTaskDone(args.pool, args.writeTaskId, "passed", args.writer);
  await args.appendEvent("task.completed", { taskKind: "write" }, args.writeTaskId);
  return { kind: "completed", writer: writerResult };
}

// Emit the (previously latent) `writer.subtask.failed` timeline event so a
// crashed / timed-out / window-exhausted writer is recorded loudly with its
// failure kind + message, never silently swallowed.
async function emitWriterSubtaskFailed(args: WriterStageInput, failureKind: string, message: string): Promise<void> {
  await args.appendEvent(
    "writer.subtask.failed",
    {
      runId: args.runId,
      taskId: args.writeTaskId,
      subtaskIndex: args.subtask.index,
      intent: args.subtask.intent,
      failureKind,
      message,
    },
    args.writeTaskId,
  );
}
