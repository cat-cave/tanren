// real planner workflow. Orchestrates plan -> per-subtask write +
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
import type { CiWhen } from "../ci/index.js";
import type { EscapeHatches } from "../config/shared.js";
import type { CostRecorder } from "../costs/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import type { GateOutcome } from "./gate/index.js";
import type { PlannerRejectionFeedback, PlannerSpecContext } from "./planner/planner.js";
import { checkWindowPreflight, type CreditState, observeRunAccounting } from "./subtaskAccounting.js";
import { gateRejection, handleRejection } from "./subtaskRework.js";
import { type SubtaskCostContext } from "./subtaskCost.js";
import type { RealProviderCostCapturer } from "../costs/generationCostCapture.js";
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
  buildWriterUsage?: (input: {
    subtaskTaskId: string;
    subtaskIndex: number;
    attempt: number;
    writer: WriterResult;
  }) => Record<string, unknown>;
  buildCheckerUsage?: (input: {
    checkerTaskId: string;
    subtaskIndex: number;
    verdict: CheckAnswer;
  }) => Record<string, unknown>;
  buildAuditorUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
}

export interface SubtaskLoopInput {
  pool: LoopQueryClient;
  eventStore: EventStore;
  // the lifecycle writer. When present (remote-writes on), the
  // loop's `tasks` INSERT/UPDATE route through the control plane; absent, the
  // in-process org-scoped writes run as before.
  runStateWriter?: RunStateWriter;
  recorder: CostRecorder;
  adapters: SubtaskLoopAdapters;
  context: PlannerSpecContext & {
    runId: string;
    specId: string;
    projectId: string;
    workspacePath: string;
    // The run's BASE sha (clone point), captured once after the workspace
    // clone, threaded to the writer so each subtask is judged against the
    // CUMULATIVE diff vs the run base rather than the per-subtask HEAD delta.
    // The production run path always sets it; unit callers may omit it.
    baseSha?: string;
  };
  escapeHatches: Pick<
    EscapeHatches,
    "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
  >;
  timeoutMs: number;
  onEvent?: (event: { eventType: EventName; taskId?: string }) => void;
  costHooks?: SubtaskLoopCostHooks;
  // Optional usage monitoring for the credential this run uses. When present
  // the loop runs a window pre-flight before each planner iteration (escalating
  // PROJECT_BRIEF §4.3 window pressure instead of dispatching a doomed call)
  // and reconciles the real cost (credit drawdown, else ccusage) into the run's
  // cost_records at the end.
  usageProbe?: UsageProbe;
  // Dollar value of one prepaid credit, for credit-drawdown cost. Defaults to
  // DEFAULT_CREDIT_USD_RATE (the observed Pro-account rate).
  creditUsdRate?: number;
  // the deterministic, exit-code-driven gate-check seam. Runs the CI
  // tiers mapped to a lifecycle point over the bootstrapped workspace (NO
  // Answerer). The loop calls it with when="per_iteration" after each writer
  // iteration (a fail routes back to writer rework via the planner-rerequest
  // path) and with when="pre_audit" before the audit (a fail blocks the audit
  // and routes to rework). Omitted → the gate is skipped (legacy / unit paths
  // that drive the loop without a workspace). Tests inject a mock to assert
  // routing without a live runner. `taskId` correlates the gate.* events.
  runGate?: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  // prior rejections to seed the planner's rejectionHistory with before
  // the first plan. Used by the review-rework re-entry to carry a
  // changes-requested PR review forward as planner steering, so the re-plan
  // addresses the reviewer's feedback. Empty/omitted on the normal first pass.
  seedRejections?: ReadonlyArray<PlannerRejectionFeedback>;
  // MANAGED-run real-cost capture: resolves the REAL OpenRouter `usage.cost` for a
  // call's surfaced generation id so cost_usd is a metered FACT (`provider_response`).
  // Present only on a managed run; absent (BYOK / non-managed) → cost_usd NULL.
  captureRealProviderCost?: RealProviderCostCapturer;
}

export type SubtaskLoopOutcome =
  | {
      kind: "passed";
      plannerTaskId: string;
      subtasks: ReadonlyArray<PlanSubtask>;
      plannerRerunCount: number;
    }
  | {
      kind: "retry_budget_exhausted";
      plannerRerunCount: number;
      lastRejection: PlannerRejectionFeedback;
    }
  | { kind: "halted"; plannerRerunCount: number; reason: string }
  | {
      kind: "window_exhausted";
      plannerRerunCount: number;
      provider: string;
      slot: string;
      usedPercent: number;
      resetsAt: string;
    };

export interface AppendEvent {
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
      payload,
    });
    input.onEvent?.({ eventType, taskId });
  };
  const costCtx: SubtaskCostContext = {
    recorder: input.recorder,
    runId: input.context.runId,
    specId: input.context.specId,
    projectId: input.context.projectId,
    ...(input.captureRealProviderCost !== undefined && { captureRealProviderCost: input.captureRealProviderCost }),
  };

  const plannerTaskId = `task_${randomUUID()}`;
  // Prepaid-credit balance at the first window pre-flight; the run-end credit
  // drawdown (atStart - atEnd) is the run's real marginal dollar cost.
  const creditState: CreditState = { atStart: null };

  // finalize runs run-level accounting (the real cost is only known once every
  // call has run) and reconciles it into cost_records — credit drawdown when
  // present, else ccusage — then returns the terminal outcome. Routed through
  // EVERY return so cost is captured regardless of how the run ended.
  const finalize = async (outcome: SubtaskLoopOutcome): Promise<SubtaskLoopOutcome> => {
    await observeRunAccounting(input, appendEvent, plannerTaskId, creditState);
    return outcome;
  };

  await insertPlannerTask(input.pool, input.context.runId, plannerTaskId, input.adapters.planner, input.runStateWriter);
  await appendEvent("task.started", { taskKind: "plan" }, plannerTaskId);
  await appendEvent("planner.started", { taskKind: "plan" }, plannerTaskId);

  const rejectionHistory: PlannerRejectionFeedback[] = [...(input.seedRejections ?? [])];
  let plannerRerunCount = 0;

  while (true) {
    const windowOutcome = await checkWindowPreflight(input, appendEvent, plannerTaskId, plannerRerunCount, creditState);
    if (windowOutcome !== null) {
      await markTaskDone(input.pool, plannerTaskId, "window_exhausted", input.runStateWriter);
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
      buildUsage: input.costHooks?.buildPlannerUsage,
    });

    const writerResults: { subtask: PlanSubtask; writer: WriterResult }[] = [];
    const sequence = await runSubtaskSequence({
      input,
      costCtx,
      appendEvent,
      plan,
      plannerTaskId,
      writerResults,
    });

    // A writer that exhausted its usage window mid-subtask halts the run as
    // recoverable §4.3 window pressure — the SAME terminal the pre-flight probe
    // produces. The planner task is stamped window_exhausted, not passed.
    if (sequence.kind === "window_exhausted") {
      await markTaskDone(input.pool, plannerTaskId, "window_exhausted", input.runStateWriter);
      return await finalize(sequence.outcome);
    }

    // A checker rejection OR a hard writer failure (crashed / timed out) routes
    // back through the planner-rework path; on budget exhaustion the run halts as
    // retry_budget_exhausted. Either way the failing subtask was NOT recorded passed.
    if (sequence.kind === "rejection") {
      const exhausted = await handleRejection({
        appendEvent,
        plannerTaskId,
        runId: input.context.runId,
        max: input.escapeHatches.maxPlannerRerunsPerSpec,
        rejection: sequence.rejection,
        plannerRerunCount,
        history: rejectionHistory,
      });
      if (exhausted) {
        return await finalize({
          kind: "retry_budget_exhausted",
          plannerRerunCount: plannerRerunCount + 1,
          lastRejection: sequence.rejection,
        });
      }
      plannerRerunCount += 1;
      continue;
    }

    // the slow tier (build/test) runs before the audit. A nonzero exit
    // blocks the audit — auditing a tree that does not build/test is wasted —
    // and routes the run to rework via the same planner-rerequest path.
    if (input.runGate !== undefined) {
      const preAuditGate = await input.runGate({ when: "pre_audit", taskId: plannerTaskId });
      if (!preAuditGate.passed) {
        const gateReject = gateRejection(preAuditGate, plan.subtasks);
        const exhausted = await handleRejection({
          appendEvent,
          plannerTaskId,
          runId: input.context.runId,
          max: input.escapeHatches.maxPlannerRerunsPerSpec,
          rejection: gateReject,
          plannerRerunCount,
          history: rejectionHistory,
        });
        if (exhausted) {
          return await finalize({
            kind: "retry_budget_exhausted",
            plannerRerunCount: plannerRerunCount + 1,
            lastRejection: gateReject,
          });
        }
        plannerRerunCount += 1;
        continue;
      }
    }

    const audit = await runAuditorStage({
      pool: input.pool,
      writer: input.runStateWriter,
      costCtx,
      adapter: input.adapters.auditor,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      plan,
      ...(input.context.baseSha === undefined ? {} : { baseSha: input.context.baseSha }),
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
      timeoutMs: input.timeoutMs,
      appendEvent,
      buildUsage: input.costHooks?.buildAuditorUsage,
    });
    if (audit.decision.kind === "pass") {
      await markTaskDone(input.pool, plannerTaskId, "passed", input.runStateWriter);
      return await finalize({
        kind: "passed",
        plannerTaskId,
        subtasks: plan.subtasks,
        plannerRerunCount,
      });
    }
    if (audit.decision.action === "halt") {
      await markTaskDone(input.pool, plannerTaskId, "rejected_by_auditor", input.runStateWriter);
      return await finalize({ kind: "halted", plannerRerunCount, reason: audit.decision.reason });
    }
    const auditorRejection: PlannerRejectionFeedback = {
      producer: "auditor",
      rejectionReason: audit.decision.reason,
      behaviorIdsFailed: [...audit.decision.outstandingBehaviorIds],
      previousSubtasks: plan.subtasks,
    };
    const exhausted = await handleRejection({
      appendEvent,
      plannerTaskId,
      runId: input.context.runId,
      max: input.escapeHatches.maxPlannerRerunsPerSpec,
      rejection: auditorRejection,
      plannerRerunCount,
      history: rejectionHistory,
    });
    if (exhausted) {
      return await finalize({
        kind: "retry_budget_exhausted",
        plannerRerunCount: plannerRerunCount + 1,
        lastRejection: auditorRejection,
      });
    }
    plannerRerunCount += 1;
  }
}

// The result of walking a plan's subtasks: a clean pass, a rejection routed to
// rework (checker reject OR a hard crashed/timeout writer), or a window-exhausted
// halt (a writer whose §4.3 usage window was spent mid-call). Each non-pass case
// guarantees the failing subtask was NOT recorded as a passed task.
type SubtaskSequenceResult =
  | { kind: "passed" }
  | { kind: "rejection"; rejection: PlannerRejectionFeedback }
  | { kind: "window_exhausted"; outcome: Extract<SubtaskLoopOutcome, { kind: "window_exhausted" }> };

// runSubtaskSequence walks the plan in order, executing each subtask's
// writer + check stages. Returns `passed` on success, a `rejection` when the
// checker rejected OR the writer hard-failed (crashed / timed out), or
// `window_exhausted` when a writer's usage window was spent mid-subtask.
async function runSubtaskSequence(args: {
  input: SubtaskLoopInput;
  costCtx: SubtaskCostContext;
  appendEvent: AppendEvent;
  plan: PlanAnswer;
  plannerTaskId: string;
  writerResults: { subtask: PlanSubtask; writer: WriterResult }[];
}): Promise<SubtaskSequenceResult> {
  const { input, costCtx, appendEvent, plan, plannerTaskId, writerResults } = args;
  for (const subtask of plan.subtasks) {
    const writeTaskId = `task_${randomUUID()}`;
    const writerOutcome = await runWriterStage({
      pool: input.pool,
      writer: input.runStateWriter,
      costCtx,
      adapter: input.adapters.writer,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      subtask,
      writeTaskId,
      prompt: writerPromptFor(input, subtask),
      timeoutMs: input.timeoutMs,
      baseSha: input.context.baseSha,
      appendEvent,
      buildUsage: input.costHooks?.buildWriterUsage,
    });
    // The writer's classified exit (provider `exitReason`) decides routing here —
    // a non-`completed` writer never proceeds to the checker as a success.
    if (writerOutcome.kind === "window_exhausted") {
      return {
        kind: "window_exhausted",
        outcome: {
          kind: "window_exhausted",
          plannerRerunCount: 0,
          provider: input.adapters.writer.cli,
          slot: "writer",
          usedPercent: 100,
          resetsAt: new Date().toISOString(),
        },
      };
    }
    if (writerOutcome.kind === "failed") {
      return { kind: "rejection", rejection: writerFailureRejection(writerOutcome.failureKind, plan.subtasks) };
    }
    const writerResult = writerOutcome.writer;
    // deterministic per-iteration gate. The fast tier runs over the
    // bootstrapped workspace right after the writer edits. A nonzero exit means
    // the tree is broken (build/lint/typecheck/unit), so route straight back to
    // writer rework via the planner-rerequest path BEFORE spending a checker
    // call on a known-broken tree.
    if (input.runGate !== undefined) {
      const gate = await input.runGate({ when: "per_iteration", taskId: writeTaskId });
      if (!gate.passed) {
        return { kind: "rejection", rejection: gateRejection(gate, plan.subtasks) };
      }
    }
    const checkerTaskId = `task_${randomUUID()}`;
    const decision = await runCheckerStage({
      pool: input.pool,
      writer: input.runStateWriter,
      costCtx,
      adapter: input.adapters.checker,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      writeTaskId,
      checkerTaskId,
      subtask,
      writerResult,
      ...(input.context.baseSha === undefined ? {} : { baseSha: input.context.baseSha }),
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
      timeoutMs: input.timeoutMs,
      appendEvent,
      buildUsage: input.costHooks?.buildCheckerUsage,
    });
    if (decision.kind === "reject") {
      return {
        kind: "rejection",
        rejection: {
          producer: "checker",
          rejectionReason: decision.reason,
          behaviorIdsFailed: [...decision.behaviorIdsFailed],
          previousSubtasks: plan.subtasks,
        },
      };
    }
    writerResults.push({ subtask, writer: writerResult });
  }
  return { kind: "passed" };
}

// Turn a hard writer failure (crashed / timed out) into the planner-feedback
// record routed through the SAME rework path the checker/auditor/gate use, so a
// non-completing writer re-plans (or exhausts the retry budget) instead of being
// laundered into a passed subtask. The writer carries no per-behavior verdict, so
// behaviorIdsFailed is empty.
function writerFailureRejection(
  failureKind: "crashed" | "timeout",
  subtasks: ReadonlyArray<PlanSubtask>,
): PlannerRejectionFeedback {
  const detail = failureKind === "timeout" ? "timed out before completing the subtask" : "crashed mid-subtask";
  return {
    producer: "writer",
    rejectionReason: `writer ${detail} (exitReason="${failureKind}")`,
    behaviorIdsFailed: [],
    previousSubtasks: subtasks,
  };
}

// A standing toolchain instruction prepended to every writer prompt. The
// acceptance criteria reach the CHECKER, but the writer never saw them — so a
// writer could (and did, in the #273 scaffold) emit `workspace:*` stub packages
// for the toolchain that the checker then correctly rejected, burning an
// iteration. Stating the rule up front steers the writer away from the failure
// mode before it spends the iteration.
const WRITER_TOOLCHAIN_INSTRUCTION =
  "Declare real, published devDependencies and a real lockfile. NEVER create local " +
  "workspace stub packages, `workspace:*` placeholders, or fake binaries for typescript/eslint/vitest " +
  "or any toolchain — use the real published packages.";

function writerPromptFor(input: SubtaskLoopInput, subtask: PlanSubtask): string {
  // The spec's acceptance criteria are the SAME bar the checker judges against, so
  // threading them into the writer prompt lets the writer aim at the gate directly
  // instead of guessing from the intent + spec description alone. They are already
  // in scope on `input.context` (PlannerSpecContext); no extra plumbing needed.
  const criteria =
    input.context.acceptanceCriteria.length > 0
      ? ["", "Acceptance criteria:", ...input.context.acceptanceCriteria.map((criterion) => `- ${criterion}`)]
      : [];
  return [
    `Subtask [${subtask.index}]: ${subtask.title}`,
    `Intent: ${subtask.intent}`,
    `Behaviors: ${subtask.behaviorIds.join(", ") || "(none)"}`,
    "",
    `Spec: ${input.context.specTitle}`,
    input.context.specDescription,
    ...criteria,
    "",
    WRITER_TOOLCHAIN_INSTRUCTION,
  ].join("\n");
}
