// P2A-0012: real planner workflow. Orchestrates plan -> per-subtask write +
// check -> audit, with checker- and auditor-rejection loops that re-invoke
// the planner with structured feedback up to the configured retry budget.
// On budget exhaustion the run halts with outcome="retry_budget_exhausted"
// and persists every rejection as a typed event.
//
// Task persistence model: subtasks are stored as child rows in the existing
// `tasks` table (Option B in the spec). The planner task is the parent; each
// subtask creates a write task with `parent_task_id = plannerTaskId`. The
// existing `attempt` column carries the writer-retry attempt number per
// subtask. No new table is required.
//
// Per-stage detail lives in subtaskStages.ts; per-call cost recording lives
// in subtaskCost.ts; task-row persistence lives in subtaskTasks.ts. This file
// stays focused on the loop topology under the 500-line architecture cap.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuditAnswer, CheckAnswer, PlanAnswer, PlanSubtask } from "../answerers/schemas/index.js";
import type { EscapeHatches } from "../config/shared.js";
import { type CostRecorder } from "../costs/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import type { PlannerRejectionFeedback, PlannerSpecContext } from "./planner/planner.js";
import { type SubtaskCostContext } from "./subtaskCost.js";
import { insertPlannerTask, markTaskDone } from "./subtaskTasks.js";
import { runAuditorStage, runCheckerStage, runPlannerStage, runWriterStage } from "./subtaskStages.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface SubtaskLoopAdapters {
  planner: AnswererAdapter<PlanAnswer>;
  writer: WriterAdapter;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
}

export interface SubtaskLoopCostHooks {
  buildPlannerUsage?: (input: { plannerTaskId: string; attempt: number }) => Record<string, unknown>;
  buildWriterUsage?: (input: { subtaskTaskId: string; subtaskIndex: number; attempt: number; writer: WriterResult }) => Record<string, unknown>;
  buildCheckerUsage?: (input: { checkerTaskId: string; subtaskIndex: number; verdict: CheckAnswer }) => Record<string, unknown>;
  buildAuditorUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
}

export interface SubtaskLoopInput {
  pool: LoopQueryClient;
  eventStore: EventStore;
  recorder: CostRecorder;
  adapters: SubtaskLoopAdapters;
  context: PlannerSpecContext & {
    runId: string;
    specId: string;
    projectId: string;
    workspacePath: string;
  };
  escapeHatches: Pick<EscapeHatches, "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure">;
  timeoutMs: number;
  onEvent?: (event: { eventType: EventName; taskId?: string }) => void;
  costHooks?: SubtaskLoopCostHooks;
  // Optional usage monitoring for the credential this run uses. When present
  // the loop runs a window pre-flight before each planner iteration (escalating
  // PROJECT_BRIEF §4.3 window pressure instead of dispatching a doomed call)
  // and reconciles the real ccusage cost into the run's cost_records at the end.
  usageProbe?: UsageProbe;
}

export type SubtaskLoopOutcome =
  | { kind: "passed"; plannerTaskId: string; subtasks: ReadonlyArray<PlanSubtask>; plannerRerunCount: number }
  | { kind: "retry_budget_exhausted"; plannerRerunCount: number; lastRejection: PlannerRejectionFeedback }
  | { kind: "halted"; plannerRerunCount: number; reason: string }
  | { kind: "window_exhausted"; plannerRerunCount: number; provider: string; slot: string; usedPercent: number; resetsAt: string };

interface AppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

export async function runSubtaskLoop(input: SubtaskLoopInput): Promise<SubtaskLoopOutcome> {
  const appendEvent: AppendEvent = async (eventType, payload, taskId) => {
    await input.eventStore.append({
      runId: input.context.runId,
      specId: input.context.specId,
      projectId: input.context.projectId,
      taskId,
      eventType,
      payload
    });
    input.onEvent?.({ eventType, taskId });
  };
  const costCtx: SubtaskCostContext = {
    recorder: input.recorder,
    runId: input.context.runId,
    specId: input.context.specId,
    projectId: input.context.projectId
  };

  const plannerTaskId = `task_${randomUUID()}`;

  // finalize runs run-level ccusage accounting (the real cost figure is only
  // known once every call has run) and reconciles it into cost_records, then
  // returns the terminal outcome. Routed through EVERY return so cost is
  // captured regardless of how the run ended.
  const finalize = async (outcome: SubtaskLoopOutcome): Promise<SubtaskLoopOutcome> => {
    await observeRunAccounting(input, appendEvent, plannerTaskId);
    return outcome;
  };

  await insertPlannerTask(input.pool, input.context.runId, plannerTaskId, input.adapters.planner);
  await appendEvent("task.started", { taskKind: "plan" }, plannerTaskId);
  await appendEvent("planner.started", { taskKind: "plan" }, plannerTaskId);

  const rejectionHistory: PlannerRejectionFeedback[] = [];
  let plannerRerunCount = 0;

  while (true) {
    const windowOutcome = await checkWindowPreflight(input, appendEvent, plannerTaskId, plannerRerunCount);
    if (windowOutcome !== null) {
      await markTaskDone(input.pool, plannerTaskId, "window_exhausted");
      return await finalize(windowOutcome);
    }
    const plan = await runPlannerStage({
      pool: input.pool,
      costCtx,
      adapter: input.adapters.planner,
      spec: input.context,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      appendEvent,
      attempt: plannerRerunCount + 1,
      rejectionHistory,
      timeoutMs: input.timeoutMs,
      buildUsage: input.costHooks?.buildPlannerUsage
    });

    const writerResults: { subtask: PlanSubtask; writer: WriterResult }[] = [];
    const checkerRejection = await runSubtaskSequence({
      input, costCtx, appendEvent, plan, plannerTaskId, writerResults
    });

    if (checkerRejection !== undefined) {
      const exhausted = await handleRejection({
        appendEvent, plannerTaskId, runId: input.context.runId,
        max: input.escapeHatches.maxPlannerRerunsPerSpec,
        rejection: checkerRejection,
        plannerRerunCount,
        history: rejectionHistory
      });
      if (exhausted) {
        return await finalize({ kind: "retry_budget_exhausted", plannerRerunCount: plannerRerunCount + 1, lastRejection: checkerRejection });
      }
      plannerRerunCount += 1;
      continue;
    }

    const audit = await runAuditorStage({
      pool: input.pool,
      costCtx,
      adapter: input.adapters.auditor,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      plan,
      combinedDiff: combineDiffs(writerResults.map((r) => r.writer)),
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
      timeoutMs: input.timeoutMs,
      appendEvent,
      buildUsage: input.costHooks?.buildAuditorUsage
    });
    if (audit.decision.kind === "pass") {
      await markTaskDone(input.pool, plannerTaskId, "passed");
      return await finalize({ kind: "passed", plannerTaskId, subtasks: plan.subtasks, plannerRerunCount });
    }
    if (audit.decision.action === "halt") {
      await markTaskDone(input.pool, plannerTaskId, "rejected_by_auditor");
      return await finalize({ kind: "halted", plannerRerunCount, reason: audit.decision.reason });
    }
    const auditorRejection: PlannerRejectionFeedback = {
      producer: "auditor",
      rejectionReason: audit.decision.reason,
      behaviorIdsFailed: [...audit.decision.outstandingBehaviorIds],
      previousSubtasks: plan.subtasks
    };
    const exhausted = await handleRejection({
      appendEvent, plannerTaskId, runId: input.context.runId,
      max: input.escapeHatches.maxPlannerRerunsPerSpec,
      rejection: auditorRejection,
      plannerRerunCount,
      history: rejectionHistory
    });
    if (exhausted) {
      return await finalize({ kind: "retry_budget_exhausted", plannerRerunCount: plannerRerunCount + 1, lastRejection: auditorRejection });
    }
    plannerRerunCount += 1;
  }
}

// checkWindowPreflight reads the live subscription-window state (codexbar) for
// the run's credential and escalates PROJECT_BRIEF §4.3 window pressure. It
// emits usage.window.observed for the live state and, when a window is at/over
// the pressure threshold, usage.window.pressure plus a window_exhausted
// outcome so the loop halts BEFORE dispatching a doomed planner call. No probe
// (or no data) → returns null (proceed normally).
async function checkWindowPreflight(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  plannerRerunCount: number
): Promise<Extract<SubtaskLoopOutcome, { kind: "window_exhausted" }> | null> {
  if (input.usageProbe === undefined) {
    return null;
  }
  const { usage, pressure } = await input.usageProbe.observeWindow();
  if (usage !== null) {
    await appendEvent(
      "usage.window.observed",
      {
        provider: usage.provider,
        windows: usage.windows.map((window) => ({
          slot: window.slot,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          windowMinutes: window.windowMinutes,
          resetDescription: window.resetDescription
        })),
        creditsRemaining: usage.creditsRemaining,
        source: usage.source,
        capturedAt: usage.capturedAt
      },
      plannerTaskId
    );
  }
  if (pressure === null) {
    return null;
  }
  const provider = usage?.provider ?? "unknown";
  await appendEvent(
    "usage.window.pressure",
    { provider, slot: pressure.slot, usedPercent: pressure.usedPercent, resetsAt: pressure.resetsAt },
    plannerTaskId
  );
  return {
    kind: "window_exhausted",
    plannerRerunCount,
    provider,
    slot: pressure.slot,
    usedPercent: pressure.usedPercent,
    resetsAt: pressure.resetsAt
  };
}

// observeRunAccounting reads run-cumulative token accounting (ccusage) once at
// run end and, when ccusage reports a positive cost, reconciles the real dollar
// figure into the run's cost_records (apportioned by token share). It emits
// usage.accounting.observed with the disjoint token totals regardless of cost.
async function observeRunAccounting(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string
): Promise<void> {
  if (input.usageProbe === undefined) {
    return;
  }
  const accounting = await input.usageProbe.observeAccounting();
  if (accounting === null) {
    return;
  }
  await appendEvent(
    "usage.accounting.observed",
    { cli: accounting.cli, totals: accounting.totals, costUsd: accounting.costUsd, capturedAt: accounting.capturedAt },
    plannerTaskId
  );
  if (accounting.costUsd !== null) {
    await input.recorder.reconcileRunCostFromCcusage(input.context.runId, accounting.costUsd);
  }
}

// runSubtaskSequence walks the plan in order, executing each subtask's
// writer + check stages. Returns undefined on success, or a populated
// rejection feedback record when the checker rejected a subtask.
async function runSubtaskSequence(args: {
  input: SubtaskLoopInput;
  costCtx: SubtaskCostContext;
  appendEvent: AppendEvent;
  plan: PlanAnswer;
  plannerTaskId: string;
  writerResults: { subtask: PlanSubtask; writer: WriterResult }[];
}): Promise<PlannerRejectionFeedback | undefined> {
  const { input, costCtx, appendEvent, plan, plannerTaskId, writerResults } = args;
  for (const subtask of plan.subtasks) {
    const writeTaskId = `task_${randomUUID()}`;
    const writerResult = await runWriterStage({
      pool: input.pool,
      costCtx,
      adapter: input.adapters.writer,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      subtask,
      writeTaskId,
      prompt: writerPromptFor(input, subtask),
      timeoutMs: input.timeoutMs,
      appendEvent,
      buildUsage: input.costHooks?.buildWriterUsage
    });
    const checkerTaskId = `task_${randomUUID()}`;
    const decision = await runCheckerStage({
      pool: input.pool,
      costCtx,
      adapter: input.adapters.checker,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      writeTaskId,
      checkerTaskId,
      subtask,
      writerResult,
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
      timeoutMs: input.timeoutMs,
      appendEvent,
      buildUsage: input.costHooks?.buildCheckerUsage
    });
    if (decision.kind === "reject") {
      return {
        producer: "checker",
        rejectionReason: decision.reason,
        behaviorIdsFailed: [...decision.behaviorIdsFailed],
        previousSubtasks: plan.subtasks
      };
    }
    writerResults.push({ subtask, writer: writerResult });
  }
  return undefined;
}

async function handleRejection(args: {
  appendEvent: AppendEvent;
  plannerTaskId: string;
  runId: string;
  max: number;
  rejection: PlannerRejectionFeedback;
  plannerRerunCount: number;
  history: PlannerRejectionFeedback[];
}): Promise<boolean> {
  const nextCount = args.plannerRerunCount + 1;
  if (nextCount > args.max) {
    return true;
  }
  await args.appendEvent(
    "planner.rerequested",
    {
      runId: args.runId,
      plannerTaskId: args.plannerTaskId,
      producer: args.rejection.producer,
      rejectionReason: args.rejection.rejectionReason,
      behaviorIdsFailed: [...args.rejection.behaviorIdsFailed],
      plannerRerunCount: nextCount,
      maxPlannerRerunsPerSpec: args.max
    },
    args.plannerTaskId
  );
  args.history.push(args.rejection);
  return false;
}

function writerPromptFor(input: SubtaskLoopInput, subtask: PlanSubtask): string {
  return [
    `Subtask [${subtask.index}]: ${subtask.title}`,
    `Intent: ${subtask.intent}`,
    `Behaviors: ${subtask.behaviorIds.join(", ") || "(none)"}`,
    "",
    `Spec: ${input.context.specTitle}`,
    input.context.specDescription
  ].join("\n");
}

function combineDiffs(results: ReadonlyArray<WriterResult>): string {
  return results.map((result) => result.diff).filter((diff) => diff.length > 0).join("\n");
}
