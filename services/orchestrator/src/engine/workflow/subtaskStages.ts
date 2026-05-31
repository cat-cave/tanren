// P2A-0012: per-call stage functions for the planner-feedback loop. Each
// stage owns a single planner / writer / checker / auditor invocation
// (event append, cost record, task-row update). The orchestrator in
// subtaskLoop.ts sequences these stages; this file holds the inner detail
// so each module stays under the 500-line architecture cap.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuditAnswer, CheckAnswer, PlanAnswer, PlanSubtask } from "../answerers/schemas/index.js";
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
import { insertChildTask, markTaskDone } from "./subtaskTasks.js";

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
  // P3-0029: stage-transition latency as a structured timing log (no schema).
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

export async function runWriterStage(args: WriterStageInput): Promise<WriterResult> {
  await insertChildTask(args.pool, {
    taskId: args.writeTaskId,
    runId: args.runId,
    kind: "write",
    title: `write subtask ${args.subtask.index}: ${args.subtask.title}`,
    parentTaskId: args.plannerTaskId,
    agentKind: "writer",
    cli: args.adapter.cli,
    model: null,
  });
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
  await markTaskDone(args.pool, args.writeTaskId, "passed");
  await args.appendEvent("task.completed", { taskKind: "write" }, args.writeTaskId);
  return writerResult;
}

export interface CheckerStageInput {
  pool: LoopQueryClient;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<CheckAnswer>;
  runId: string;
  workspacePath: string;
  writeTaskId: string;
  checkerTaskId: string;
  subtask: PlanSubtask;
  writerResult: WriterResult;
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

export async function runCheckerStage(args: CheckerStageInput): Promise<CheckerDecision> {
  await insertChildTask(args.pool, {
    taskId: args.checkerTaskId,
    runId: args.runId,
    kind: "check",
    title: `check subtask ${args.subtask.index}`,
    parentTaskId: args.writeTaskId,
    agentKind: "answerer",
    cli: args.adapter.cli,
    model: null,
  });
  await args.appendEvent("task.started", { taskKind: "check" }, args.checkerTaskId);
  await args.appendEvent("checker.started", { taskKind: "check" }, args.checkerTaskId);
  const checkerContext: CheckerSubtaskContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtask: args.subtask,
    writerDiff: args.writerResult.diff,
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
    await markTaskDone(args.pool, args.checkerTaskId, "rejected_by_checker");
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
  await markTaskDone(args.pool, args.checkerTaskId, "passed");
  await args.appendEvent("task.completed", { taskKind: "check" }, args.checkerTaskId);
  return decision;
}

export interface AuditorStageInput {
  pool: LoopQueryClient;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<AuditAnswer>;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  plan: PlanAnswer;
  combinedDiff: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  timeoutMs: number;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
}

export async function runAuditorStage(
  args: AuditorStageInput,
): Promise<{ decision: AuditorDecision; auditorTaskId: string }> {
  const auditorTaskId = `task_${randomUUID()}`;
  await insertChildTask(args.pool, {
    taskId: auditorTaskId,
    runId: args.runId,
    kind: "audit",
    title: "audit plan",
    parentTaskId: args.plannerTaskId,
    agentKind: "answerer",
    cli: args.adapter.cli,
    model: null,
  });
  await args.appendEvent("task.started", { taskKind: "audit" }, auditorTaskId);
  await args.appendEvent("auditor.started", { taskKind: "audit" }, auditorTaskId);
  const auditorContext: AuditorSpecContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtasks: args.plan.subtasks,
    combinedDiff: args.combinedDiff,
  };
  const startedAt = Date.now();
  const result = await invokeAuditor(args.adapter, {
    context: auditorContext,
    timeoutMs: args.timeoutMs,
    workspace: args.workspacePath,
  });
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  await args.appendEvent(
    "auditor.verdict",
    {
      runId: args.runId,
      passed: result.verdict.passed,
      reasoning: result.verdict.reasoning,
      outstandingBehaviorIds: [...result.verdict.outstandingBehaviorIds],
      recommendedAction: result.verdict.recommendedAction,
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
    await markTaskDone(args.pool, auditorTaskId, "passed");
    await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
    return { decision, auditorTaskId };
  }
  await markTaskDone(args.pool, auditorTaskId, "rejected_by_auditor");
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
