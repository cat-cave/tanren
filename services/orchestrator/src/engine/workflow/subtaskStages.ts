// per-call stage functions for the planner-feedback loop. Each
// stage owns a single planner / writer / checker / auditor invocation
// (event append, cost record, task-row update). The orchestrator in
// subtaskLoop.ts sequences these stages; this file holds the inner detail
// so each module stays under the 500-line architecture cap.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AuditAnswer, CheckAnswer, PlanAnswer, PlanSubtask } from "../answerers/schemas/index.js";
import { normalizeFinding } from "../answerers/schemas/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "../providers/types.js";
import {
  decideAuditorOutcome,
  invokeAuditor,
  type AuditorDecision,
  type AuditorSpecContext,
} from "./auditor/auditor.js";
import {
  decideCheckerOutcome,
  invokeChecker,
  type CheckerDecision,
  type CheckerSubtaskContext,
} from "./checker/checker.js";
import { invokePlanner, type PlannerRejectionFeedback, type PlannerSpecContext } from "./planner/planner.js";
import { recordAnswererCost, recordWriterCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { insertChildTask, markTaskDone, markTaskFailed } from "./subtaskTasks.js";
import { AUDIT_FINDINGS_DUAL_EMIT_DEFAULT } from "../forge/audits/findingsDualEmit.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface StageAppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

export interface PlannerStageInput {
  pool: LoopQueryClient;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<PlanAnswer>;
  spec: PlannerSpecContext;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  appendEvent: StageAppendEvent;
  attempt: number;
  rejectionHistory: ReadonlyArray<PlannerRejectionFeedback>;
  timeoutMs: number;
  buildUsage?: (input: { plannerTaskId: string; attempt: number }) => Record<string, unknown>;
}

export async function runPlannerStage(args: PlannerStageInput): Promise<PlanAnswer> {
  const startedAt = Date.now();
  const result = await invokePlanner(args.adapter, {
    spec: args.spec,
    timeoutMs: args.timeoutMs,
    workspace: args.workspacePath,
    rejectionHistory: args.rejectionHistory,
  });
  const runtimeSeconds = secondsSince(startedAt);
  // stage-transition latency as a structured timing log (no schema).
  emitStageTiming("plan", Date.now() - startedAt, { runId: args.runId, attempt: args.attempt });
  await args.appendEvent(
    "planner.subtasks.emitted",
    {
      runId: args.runId,
      taskId: args.plannerTaskId,
      subtasks: result.plan.subtasks.map((subtask) => ({
        index: subtask.index,
        title: subtask.title,
        intent: subtask.intent,
        estimatedTokens: subtask.estimatedTokens,
        behaviorIds: [...subtask.behaviorIds],
      })),
      rationale: result.plan.rationale,
    },
    args.plannerTaskId,
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    taskId: args.plannerTaskId,
    model: "tanren-planner",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({ plannerTaskId: args.plannerTaskId, attempt: args.attempt }) ?? {
      role: "planner",
      attempt: args.attempt,
    },
  });
  return result.plan;
}

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
  timeoutMs: number;
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
  const startedAt = Date.now();
  const writerResult = await args.adapter.runWriter({
    prompt: args.prompt,
    workspace: args.workspacePath,
    timeoutMs: args.timeoutMs,
    baseSha: args.baseSha,
  });
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("write", Date.now() - startedAt, {
    runId: args.runId,
    subtaskIndex: args.subtask.index,
  });
  // The cost is recorded for EVERY outcome — a crashed / timed-out / window-
  // exhausted writer still consumed real tokens. The success event
  // (`writer.subtask.completed`) is emitted ONLY on the success branch below, so
  // a non-completing writer never claims completion.
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
  await args.appendEvent(
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

export interface CheckerStageInput {
  pool: LoopQueryClient;
  /** route the checker task INSERT/UPDATE remote when wired. */
  writer?: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<CheckAnswer>;
  runId: string;
  workspacePath: string;
  writeTaskId: string;
  checkerTaskId: string;
  subtask: PlanSubtask;
  writerResult: WriterResult;
  // The run base the writer's change is diffed against. The checker inspects the
  // change itself in its read-only workspace rather than receiving an injected
  // diff (which can balloon past the model's input limit). Omitted by unit
  // callers that drive the stage without a base sha.
  baseSha?: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  timeoutMs: number;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: {
    checkerTaskId: string;
    subtaskIndex: number;
    verdict: CheckAnswer;
  }) => Record<string, unknown>;
}

// The base sha the checker tells the Answerer to diff against. The production
// loop threads the run base (`baseSha`); when it is absent (unit callers that
// drive the stage without a base) we fall back to the parent of the writer's
// first commit, or `HEAD` when the writer produced no commits — so the prompt
// always carries a usable git ref.
function checkerBaselineSha(args: CheckerStageInput): string {
  if (args.baseSha !== undefined) {
    return args.baseSha;
  }
  const firstCommit = args.writerResult.commits[0];
  return firstCommit === undefined ? "HEAD" : `${firstCommit.sha}~1`;
}

export async function runCheckerStage(args: CheckerStageInput): Promise<CheckerDecision> {
  await insertChildTask(
    args.pool,
    {
      taskId: args.checkerTaskId,
      runId: args.runId,
      kind: "check",
      title: `check subtask ${args.subtask.index}`,
      parentTaskId: args.writeTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "check" }, args.checkerTaskId);
  await args.appendEvent("checker.started", { taskKind: "check" }, args.checkerTaskId);
  const checkerContext: CheckerSubtaskContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtask: args.subtask,
    baselineSha: checkerBaselineSha(args),
  };
  const startedAt = Date.now();
  const result = await invokeChecker(args.adapter, {
    context: checkerContext,
    timeoutMs: args.timeoutMs,
    workspace: args.workspacePath,
  });
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("check", Date.now() - startedAt, {
    runId: args.runId,
    subtaskIndex: args.subtask.index,
  });
  await args.appendEvent(
    "checker.verdict",
    {
      runId: args.runId,
      taskId: args.checkerTaskId,
      subtaskIndex: args.subtask.index,
      passed: result.verdict.passed,
      reasoning: result.verdict.reasoning,
      behaviorIdsPassed: [...result.verdict.behaviorIdsPassed],
      behaviorIdsFailed: [...result.verdict.behaviorIdsFailed],
    },
    args.checkerTaskId,
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    taskId: args.checkerTaskId,
    model: "tanren-checker",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({
      checkerTaskId: args.checkerTaskId,
      subtaskIndex: args.subtask.index,
      verdict: result.verdict,
    }) ?? { role: "checker", subtaskIndex: args.subtask.index },
  });
  const decision = decideCheckerOutcome(result.verdict);
  if (decision.kind === "reject") {
    await markTaskDone(args.pool, args.checkerTaskId, "rejected_by_checker", args.writer);
    await args.appendEvent(
      "checker.rejected",
      {
        runId: args.runId,
        taskId: args.checkerTaskId,
        subtaskIndex: args.subtask.index,
        reason: decision.reason,
        behaviorIdsFailed: [...decision.behaviorIdsFailed],
      },
      args.checkerTaskId,
    );
    await args.appendEvent("task.completed", { taskKind: "check" }, args.checkerTaskId);
    return decision;
  }
  await markTaskDone(args.pool, args.checkerTaskId, "passed", args.writer);
  await args.appendEvent("task.completed", { taskKind: "check" }, args.checkerTaskId);
  return decision;
}

export interface AuditorStageInput {
  pool: LoopQueryClient;
  /** route the auditor task INSERT/UPDATE remote when wired. */
  writer?: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<AuditAnswer>;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  plan: PlanAnswer;
  // The run base the combined writer change is diffed against. The auditor
  // inspects the change itself in its read-only workspace rather than receiving
  // an injected combined diff. Omitted by unit callers without a base sha.
  baseSha?: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  timeoutMs: number;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
  // WAVE-2 / SLICE P-A de-risk flag: dual-emit the explicit `findings` list on
  // `auditor.verdict` alongside the legacy verdict. Defaults to the governed
  // `AUDIT_FINDINGS_DUAL_EMIT_DEFAULT` (ON); a focused test may force it OFF.
  dualEmitFindings?: boolean;
}

export async function runAuditorStage(
  args: AuditorStageInput,
): Promise<{ decision: AuditorDecision; auditorTaskId: string }> {
  const auditorTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: auditorTaskId,
      runId: args.runId,
      kind: "audit",
      title: "audit plan",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "audit" }, auditorTaskId);
  await args.appendEvent("auditor.started", { taskKind: "audit" }, auditorTaskId);
  const auditorContext: AuditorSpecContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtasks: args.plan.subtasks,
    baselineSha: args.baseSha ?? "HEAD",
  };
  const startedAt = Date.now();
  const result = await invokeAuditor(args.adapter, {
    context: auditorContext,
    timeoutMs: args.timeoutMs,
    workspace: args.workspacePath,
  });
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  // WAVE-2 dual-emit: carry the explicit findings list alongside the legacy
  // verdict when the de-risk flag is on (the default). The findings are the new
  // first-class severity currency the DagLifecycle read model + posture policy read.
  const emitFindings = args.dualEmitFindings ?? AUDIT_FINDINGS_DUAL_EMIT_DEFAULT;
  await args.appendEvent(
    "auditor.verdict",
    {
      runId: args.runId,
      passed: result.verdict.passed,
      reasoning: result.verdict.reasoning,
      outstandingBehaviorIds: [...result.verdict.outstandingBehaviorIds],
      recommendedAction: result.verdict.recommendedAction,
      ...(emitFindings && {
        // The adapter returns a PARSED answer (findings defaulted to []); a raw
        // fixture verdict may omit it, so coalesce to an empty list. `normalizeFinding`
        // collapses a strict-schema `fixHint: null` to an absent key so the stored
        // shape matches the frozen `{ fixHint?: string }` contract.
        findings: (result.verdict.findings ?? []).map((f) => normalizeFinding(f)),
      }),
    },
    auditorTaskId,
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    taskId: auditorTaskId,
    model: "tanren-auditor",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({ auditorTaskId, verdict: result.verdict }) ?? { role: "auditor" },
  });
  const decision = decideAuditorOutcome(result.verdict);
  if (decision.kind === "pass") {
    await markTaskDone(args.pool, auditorTaskId, "passed", args.writer);
    await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
    return { decision, auditorTaskId };
  }
  await markTaskDone(args.pool, auditorTaskId, "rejected_by_auditor", args.writer);
  await args.appendEvent(
    "auditor.rejected",
    {
      runId: args.runId,
      auditTaskId: auditorTaskId,
      reason: decision.reason,
      outstandingBehaviorIds: [...decision.outstandingBehaviorIds],
      recommendedAction: decision.action,
    },
    auditorTaskId,
  );
  await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
  return { decision, auditorTaskId };
}
