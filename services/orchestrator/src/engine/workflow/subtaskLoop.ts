// The spec-implementation loop (docs/roadmap/spec-loop-redesign.md). Orchestrates:
//
//   PLANNER → per-task[ WRITER → FAST GATE (tier-1) → CHECKER ] → SPEC GATE (tier-2,
//   CI-fail=P0) → AUDITOR → DEMO (optional) → findings?
//      none                → PASS
//      yes → TRIAGE → all-routed-to-specs → PASS
//                  → kept-in-spec → CONVERGENCE → progress → loop
//                                              → velocity → PASS
//                                              → stall (N consecutive) → HALT
//
// HALT RULES (the redesign's core): there is NO retry-cap / per-spec rerun limit /
// timeout HALT. The ONLY halts are (a) convergence stall (the convergence answerer,
// after N CONSECUTIVE stalls — a stall counter, NOT a retry counter) and (b) budget
// exhaustion (handled at the project/walker level, OUTSIDE this loop). A P0 finding, a
// failed gate, an incomplete task are LOOPBACKS, not halts.
//
// Per-stage detail lives in subtaskStages.ts (writer/checker), auditorStage.ts, and
// loopStages.ts (demo/triage/convergence); per-call cost in subtaskCost.ts; task-row
// persistence in subtaskTasks.ts. This file stays focused on the loop topology under
// the 500-line architecture cap.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  AuditAnswer,
  CheckAnswer,
  ConvergenceAnswer,
  DemoRunAnswer,
  DesignOracleAnswer,
  PlanAnswer,
  PlanSubtask,
  TriageAnswer,
} from "../answerers/schemas/index.js";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorRef } from "../state/actor.js";
import type { CiWhen } from "../ci/index.js";
import {
  type AuditPostureConfig,
  type ConvergencePolicyConfig,
  DEFAULT_CONVERGENCE_POLICY,
  resolveDefaultAuditPosture,
} from "../config/shared.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import { type Finding, type FindingSeverity, severityRank } from "../contracts/findings.js";
import type { CostRecorder } from "../costs/index.js";
import type { EntityMapProduction } from "../oracle/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import type { GateOutcome } from "./gate/index.js";
import type { PlannerRejectionFeedback, PlannerSpecContext } from "./planner/planner.js";
import { checkWindowPreflight, type CreditState, observeRunAccounting } from "./subtaskAccounting.js";
import { budgetPausedOutcome, checkIterationBudget, emitBudgetPause } from "./subtaskBudget.js";
import { buildSubtaskCostContext, type SubtaskCostContext } from "./subtaskCost.js";
import type { RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import { insertPlannerTask, markTaskDone } from "./subtaskTasks.js";
import { runAuditorStage, runPlannerStage } from "./subtaskStages.js";
import { runSubtaskSequence } from "./subtaskInnerLoop.js";
import { runConvergenceStage, runPostAuditFindingStages, runTriageStage } from "./loopStages.js";
import { type ConvergenceState, type RoutedWorkItem } from "./loopPolicy.js";
import { gateFindings, routedToNewSpec, triageToRejection, type TriageSpecValidator } from "./loopFindings.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("subtask-loop");

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The worst severity among the work items KEPT in-spec this loopback — the "are the
// leftovers mild?" input to the velocity-defer policy. Undefined when nothing was
// kept (the leftover-severity gate is then vacuously satisfied).
function worstKeptSeverity(kept: ReadonlyArray<RoutedWorkItem>): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const { item } of kept) {
    if (worst === undefined || severityRank(item.severity) < severityRank(worst)) {
      worst = item.severity;
    }
  }
  return worst;
}

export interface SubtaskLoopAdapters {
  planner: AnswererAdapter<PlanAnswer>;
  writer: WriterAdapter;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
  // SPEC-LOOP REDESIGN stages.
  triage: AnswererAdapter<TriageAnswer>;
  convergence: AnswererAdapter<ConvergenceAnswer>;
  // The OPTIONAL demo-run answerer. Present even when disabled (the policy flag, not
  // the adapter's absence, governs whether the stage runs) so the slot is always wired.
  demoRun: AnswererAdapter<DemoRunAnswer>;
  // WS-D4 native design subsystem — the design-fidelity ORACLE answerer. Always wired;
  // the STAGE self-skips when the project has no design contract (the verify→re-drive
  // half of the design loop runs whenever a contract exists — no kill-switch).
  designOracle: AnswererAdapter<DesignOracleAnswer>;
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
  runStateWriter?: RunStateWriter;
  recorder: CostRecorder;
  adapters: SubtaskLoopAdapters;
  context: PlannerSpecContext & {
    runId: string;
    specId: string;
    projectId: string;
    workspacePath: string;
    baseSha?: string;
    // WS-D2 (native design subsystem): the rendered design block for the project's HEAD
    // `DesignContract` (persona-scoped, behavior-linked, domain-general). Injected into the
    // writer prompt so the build honors the design. Absent ⇒ no design contract ⇒ no block.
    designContextBlock?: string;
  };
  // The CONVERGENCE policy (the SOLE loop bound) + the audit posture (triage routing).
  // Optional → resolve to the balanced defaults.
  convergencePolicy?: ConvergencePolicyConfig;
  auditPosture?: AuditPostureConfig;
  onEvent?: (event: { eventType: EventName; taskId?: string }) => void;
  costHooks?: SubtaskLoopCostHooks;
  usageProbe?: UsageProbe;
  creditUsdRate?: number;
  // PER-ITERATION BUDGET GATE (audit §3.7a): resolves the project's configured dollar
  // ceiling + cumulative spend at the TOP of each loop iteration, so an in-flight run
  // halts the instant its project crosses the ceiling — not just at enqueue time. The
  // SAME org-scoped seam the DagWalker uses (PgBudgetGate). Absent ⇒ no per-iteration
  // budget enforcement (unit paths), byte-identical to before this gate.
  budgetGate?: BudgetGate;
  // the deterministic, exit-code-driven gate-check seam. `per_iteration` is the
  // tier-1 FAST gate (per task, BEFORE the checker); `pre_audit` is the tier-2 SPEC
  // gate (a CI fail becomes a P0 finding). Omitted → the gate is skipped (unit paths).
  runGate?: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  // §3.1 HOST-SIDE entity-risk producer: shells `sem diff` READ-ONLY on the run's
  // runner and normalizes it into the neutral `EntityChangeMap` the checker
  // classifies into its pre-LLM risk posture (NATIVE deterministic signal, NOT prompt
  // injection — the agent still self-inspects separately). Wired in plannerRun; absent
  // ⇒ the checker degrades to the graceful `unknown` signal (unit paths).
  entityRiskProducer?: (baselineSha: string) => Promise<EntityMapProduction>;
  // prior rejections to seed the planner's rejectionHistory (review-rework re-entry).
  seedRejections?: ReadonlyArray<PlannerRejectionFeedback>;
  captureRealProviderCost?: RealProviderCostCapturer;
  // WORKSTREAM 1 ↔ 2 SEAM — the spec-quality gate (forge/specQuality contract) applied
  // to the TRIAGE stage's `kind: spec` work items before they become NewSpecRequests.
  // Resolved per org/project in plannerRun (a real read-only validator answerer + the
  // re-author loopback). Absent ⇒ the gate is inert (unit paths).
  specValidator?: TriageSpecValidator;
  // WS-D4 native design subsystem — the actor identity the design ORACLE reads the
  // project's contract + entity graph under (org-scoped, RLS + actor-authorized). Built
  // in plannerRun from the run's org/project. Absent ⇒ the design-oracle stage is skipped
  // (unit paths with no design wiring); present ⇒ the stage runs (and self-skips cleanly
  // when the project has no contract). NEVER a kill-switch that defaults design off.
  designOracleActor?: { actor: ActorContext; actorRef: ActorRef };
}

// A new DAG spec triage routed out of this spec. Emitted through the spec-creating
// contract (workstream 1) by the caller. The id/title/body/severity come straight from
// the triaged work item.
export interface NewSpecRequest {
  id: string;
  title: string;
  body: string;
  severity: "P0" | "P1" | "P2" | "P3";
  findingIds: ReadonlyArray<string>;
}

export type SubtaskLoopOutcome =
  | {
      kind: "passed";
      plannerTaskId: string;
      subtasks: ReadonlyArray<PlanSubtask>;
      // The new DAG specs triage emitted (routed-to-spec work items + any velocity-
      // deferred kept items). The caller (workstream-1 spec-creating contract)
      // materializes these; empty when none.
      newSpecs: ReadonlyArray<NewSpecRequest>;
      loopCount: number;
    }
  | {
      // SPEC-LOOP REDESIGN: replaces `retry_budget_exhausted`. The convergence answerer
      // reported N CONSECUTIVE stalls — a human action (rework the spec / stronger
      // model / fix the env) is the genuine next step.
      kind: "convergence_stalled";
      loopCount: number;
      consecutiveStalls: number;
      reason: string;
    }
  | { kind: "halted"; loopCount: number; reason: string }
  | {
      // BUDGET PAUSE (audit §3.7a): the project crossed the configured ceiling (or the
      // gate must fail closed) DURING this in-flight run — the per-iteration check stops an
      // ALREADY-RUNNING cohort spending past the ceiling. Halts + parks the spec
      // (requeueable); raising the ceiling + requeue resumes it (escapable, never bricked).
      kind: "budget_paused";
      loopCount: number;
      ceilingUsd: number | undefined;
      spentUsd: number;
      reason: string;
    }
  | {
      kind: "window_exhausted";
      loopCount: number;
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
  const costCtx: SubtaskCostContext = buildSubtaskCostContext(
    {
      recorder: input.recorder,
      runId: input.context.runId,
      specId: input.context.specId,
      projectId: input.context.projectId,
      captureRealProviderCost: input.captureRealProviderCost,
    },
    appendEvent,
  );

  const plannerTaskId = `task_${randomUUID()}`;
  const creditState: CreditState = { atStart: null };
  // APEX-MODE-AWARE absent default: apex routes residual P2/P3 to the DAG; else BALANCED.
  const posture = input.auditPosture ?? resolveDefaultAuditPosture();
  const convergencePolicy = input.convergencePolicy ?? DEFAULT_CONVERGENCE_POLICY;

  // finalize runs run-level accounting + reconciles cost, then returns the terminal
  // outcome. Routed through EVERY return so cost is captured regardless of how the run
  // ended. GUARDED (audit §3.7d): the run-end ccusage/credit reconcile is BEST-EFFORT
  // — the control plane / usage probe can blip. The run OUTCOME (passed /
  // convergence_stalled / halted / window_exhausted) is the durable result and MUST
  // persist regardless: a transient reconcile throw must NOT discard a finished run's
  // outcome AND its spend back-fill. So the reconcile is caught LOUD-but-non-fatal —
  // the committed cost_records rows are already the row-is-truth budget source; only
  // the run-end apportion estimate is missing — and the outcome always returns.
  const finalize = async (outcome: SubtaskLoopOutcome): Promise<SubtaskLoopOutcome> => {
    try {
      await observeRunAccounting(input, appendEvent, plannerTaskId, creditState);
    } catch (error) {
      const ctx = { runId: input.context.runId, outcomeKind: outcome.kind };
      log.error("run-end cost reconcile failed; outcome preserved, only spend back-fill missing", ctx, error);
    }
    return outcome;
  };

  await insertPlannerTask(input.pool, input.context.runId, plannerTaskId, input.adapters.planner, input.runStateWriter);
  await appendEvent("task.started", { taskKind: "plan" }, plannerTaskId);
  await appendEvent("planner.started", { taskKind: "plan" }, plannerTaskId);

  const rejectionHistory: PlannerRejectionFeedback[] = [...(input.seedRejections ?? [])];
  // The cross-loop convergence state — the SOLE loop bound (NOT a retry counter). A
  // `progress`/`velocity_defer` resets it; a `stalled` increments; N consecutive halts.
  let convergenceState: ConvergenceState = { consecutiveStalls: 0 };
  let priorFindings: Finding[] = [];
  let loopCount = 0;

  while (true) {
    // PER-ITERATION BUDGET GATE (audit §3.7a): the enqueue-time gate only stops NEW
    // work — an in-flight cohort would otherwise keep spending PAST the ceiling. Re-
    // resolve the budget at the top of EVERY iteration so a run halts the instant its
    // project crosses the ceiling (or the gate fails closed — unpriced spend). The halt
    // PARKS the spec (requeueable); raising the ceiling + requeue resumes it.
    const budgetPause = await checkIterationBudget(input);
    if (budgetPause !== null) {
      await emitBudgetPause(input, appendEvent, plannerTaskId, budgetPause);
      return await finalize(budgetPausedOutcome(budgetPause, loopCount));
    }
    const windowOutcome = await checkWindowPreflight(input, appendEvent, plannerTaskId, loopCount, creditState);
    if (windowOutcome !== null) {
      await markTaskDone(input.pool, plannerTaskId, "window_exhausted", input.runStateWriter);
      return await finalize({ ...windowOutcome, loopCount });
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
      attempt: loopCount + 1,
      rejectionHistory,
      buildUsage: input.costHooks?.buildPlannerUsage,
    });

    // Per-task inner loop: WRITER → FAST GATE → CHECKER, for every subtask in order.
    const sequence = await runSubtaskSequence({ input, costCtx, appendEvent, plan, plannerTaskId });
    if (sequence.kind === "window_exhausted") {
      await markTaskDone(input.pool, plannerTaskId, "window_exhausted", input.runStateWriter);
      return await finalize({ ...sequence.outcome, loopCount });
    }

    // Collect ALL spec-level findings: per-task incompleteness + the tier-2 SPEC GATE
    // (CI fail = P0) + the auditor + the optional demo. They flow as ONE union to triage.
    const findings: Finding[] = [...sequence.taskFindings];

    if (input.runGate !== undefined) {
      const specGate = await input.runGate({ when: "pre_audit", taskId: plannerTaskId });
      if (!specGate.passed) {
        findings.push(gateFindings(specGate));
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
      appendEvent,
      buildUsage: input.costHooks?.buildAuditorUsage,
    });
    findings.push(...audit.findings);

    // OPTIONAL POST-AUDITOR finding stages: the demo-run gate (policy-enabled) + the WS-D4
    // design-oracle gate (runs whenever a design actor is wired AND a contract exists — no
    // kill-switch). Both findings merge into the SAME triage input — a genuine
    // design-fidelity gap re-drives the writer exactly like the demo/auditor.
    findings.push(
      ...(await runPostAuditFindingStages({
        pool: input.pool,
        writer: input.runStateWriter,
        costCtx,
        runId: input.context.runId,
        workspacePath: input.context.workspacePath,
        plannerTaskId,
        client: input.pool,
        projectId: input.context.projectId,
        specTitle: input.context.specTitle,
        specDescription: input.context.specDescription,
        acceptanceCriteria: input.context.acceptanceCriteria,
        baselineSha: input.context.baseSha ?? "HEAD",
        demoRunAdapter: input.adapters.demoRun,
        designOracleAdapter: input.adapters.designOracle,
        demoRunEnabled: convergencePolicy.demoRunEnabled,
        ...(input.designOracleActor !== undefined && { designOracleActor: input.designOracleActor }),
        appendEvent,
      })),
    );

    // NO findings ⇒ the spec PASSES (the clean exit).
    if (findings.length === 0) {
      await markTaskDone(input.pool, plannerTaskId, "passed", input.runStateWriter);
      return await finalize({ kind: "passed", plannerTaskId, subtasks: plan.subtasks, newSpecs: [], loopCount });
    }

    // TRIAGE: dedup findings to root-cause work items + route each (task-here / new spec).
    const triage = await runTriageStage({
      pool: input.pool,
      writer: input.runStateWriter,
      costCtx,
      adapter: input.adapters.triage,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      baselineSha: input.context.baseSha ?? "HEAD",
      findings,
      posture,
      ...(input.specValidator !== undefined && { specValidator: input.specValidator }),
      appendEvent,
    });
    const newSpecs: NewSpecRequest[] = triage.routing.newSpecs.map(routedToNewSpec);

    // TRIAGE → PASSED: every finding became a NEW spec (none kept here).
    if (triage.routing.outcome === "passed") {
      await markTaskDone(input.pool, plannerTaskId, "passed", input.runStateWriter);
      return await finalize({ kind: "passed", plannerTaskId, subtasks: plan.subtasks, newSpecs, loopCount });
    }

    // Work KEPT in-spec → CONVERGENCE: progress vs stall vs velocity-defer. The
    // velocity-defer gate reasons over the worst severity among the items KEPT here
    // (the mild-leftovers test) + the configured strategy.
    const convergence = await runConvergenceStage({
      pool: input.pool,
      writer: input.runStateWriter,
      costCtx,
      adapter: input.adapters.convergence,
      runId: input.context.runId,
      workspacePath: input.context.workspacePath,
      plannerTaskId,
      specTitle: input.context.specTitle,
      baselineSha: input.context.baseSha ?? "HEAD",
      loopIndex: loopCount,
      currentFindings: findings,
      priorFindings,
      state: convergenceState,
      velocityPolicy: {
        enabled: convergencePolicy.velocityDeferEnabled,
        maxSeverity: convergencePolicy.velocityDeferMaxSeverity,
        afterStalls: convergencePolicy.velocityDeferAfterStalls,
      },
      ...(worstKeptSeverity(triage.routing.tasksHere) !== undefined && {
        worstLeftoverSeverity: worstKeptSeverity(triage.routing.tasksHere),
      }),
      appendEvent,
    });
    convergenceState = convergence.state;

    if (convergence.decision === "halt") {
      // HALT by the agent's INTELLIGENT escalation verdict (a genuine human decision/blocker/
      // dead-end), NOT a count. The specific human-actionable reason is the agent's
      // `escalationReason`; the broader `reasoning` is the evidence trail.
      const haltReason = convergence.escalationReason === "" ? convergence.reasoning : convergence.escalationReason;
      await appendEvent("convergence.stalled", {
        runId: input.context.runId,
        consecutiveStalls: convergence.state.consecutiveStalls,
        reason: haltReason,
      });
      await markTaskDone(input.pool, plannerTaskId, "rejected_by_auditor", input.runStateWriter);
      return await finalize({
        kind: "convergence_stalled",
        loopCount,
        consecutiveStalls: convergence.state.consecutiveStalls,
        reason: haltReason,
      });
    }
    if (convergence.decision === "pass") {
      // Velocity policy: defer the mild kept leftovers as specs and ALLOW the pass.
      const deferred: NewSpecRequest[] = triage.routing.tasksHere.map(routedToNewSpec);
      await markTaskDone(input.pool, plannerTaskId, "passed", input.runStateWriter);
      return await finalize({
        kind: "passed",
        plannerTaskId,
        subtasks: plan.subtasks,
        newSpecs: [...newSpecs, ...deferred],
        loopCount,
      });
    }

    // progress → loop again. Seed the planner with the kept work as steering, carry the
    // current findings forward as the next loop's prior, and re-plan.
    rejectionHistory.push(triageToRejection(triage.routing.tasksHere, plan.subtasks));
    priorFindings = findings;
    loopCount += 1;
  }
}
