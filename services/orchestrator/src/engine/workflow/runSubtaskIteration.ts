// The per-iteration body of `runSubtaskLoop` (audit round-2 N2). Extracted so the
// outer loop in `subtaskLoop.ts` stays a thin orchestrator (loop-state init →
// iterate → finalize) under both the 500-line file cap and the 220-line function
// cap. The architecture cap had previously been a forcing function for several
// "trim a comment to fit" PRs (#706, #708, #709, #710, #711) — those were fighting
// the cap instead of addressing the real structural issue, which is that the
// per-iteration body has multiple discrete phases (plan → write+gate inner loop →
// check → audit → triage → convergence) and wants its own module.
//
// SHAPE: `runSubtaskIteration` takes the loop's per-iteration context (the immutable
// input + the mutable state the previous iteration produced) and returns either a
// TERMINAL outcome (the outer loop returns it after `finalize`) or a LOOPBACK
// (carrying the updated convergence state + the current findings for the next
// iteration's prior). The mutable `rejectionHistory` is mutated in place — same
// shape as the inline version, kept that way to preserve behavior exactly.
//
// BEHAVIOR PRESERVATION: this is a pure extraction. Every call, every order, every
// terminal write (`markPlannerFailed` / `markPlannerPassed`) and every event emit
// is identical to the inline version. The existing `subtaskLoop.test.ts` family
// (gateLoopRouting, checkerEmptyDiff, designOracleWiring, plannerLoop*,
// subtaskLoopFailurePaths) MUST pass unchanged — if any test breaks, the
// extraction has changed behavior.
import type { AuditPostureConfig, ConvergencePolicyConfig } from "../config/shared.js";
import { type Finding } from "../contracts/findings.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import { checkWindowPreflight, type CreditState } from "./subtaskAccounting.js";
import { budgetPausedOutcome, checkIterationBudget, emitBudgetPause } from "./subtaskBudget.js";
import type { SubtaskCostContext } from "./subtaskCost.js";
import type { PlannerTerminalContext } from "./subtaskTasks.js";
import { markPlannerFailed, markPlannerPassed } from "./subtaskTasks.js";
import { runAuditorStage, runPlannerStage } from "./subtaskStages.js";
import { runSubtaskSequence } from "./subtaskInnerLoop.js";
import { runConvergenceStage, runPostAuditFindingStages, runTriageStage } from "./loopStages.js";
import { type ConvergenceState } from "./loopPolicy.js";
import { worstKeptSeverity } from "./subtaskLoopHelpers.js";
import { gateFindings, routedToNewSpec, triageToRejection } from "./loopFindings.js";
import type { AppendEvent, NewSpecRequest, SubtaskLoopInput, SubtaskLoopOutcome } from "./subtaskLoop.js";

/**
 * The per-iteration context — the immutable input + the mutable state the previous
 * iteration produced. `rejectionHistory` is mutated in place by `triageToRejection`
 * on a progress loopback (same shape as the inline version); the returned LOOPBACK
 * carries the updated `convergenceState` + `priorFindings` for the next iteration.
 */
export interface SubtaskIterationContext {
  input: SubtaskLoopInput;
  costCtx: SubtaskCostContext;
  appendEvent: AppendEvent;
  plannerTaskId: string;
  planCtx: PlannerTerminalContext;
  creditState: CreditState;
  posture: AuditPostureConfig;
  convergencePolicy: ConvergencePolicyConfig;
  // The cross-loop rejection history fed back into the planner — mutated by
  // `triageToRejection` on a progress loopback so the next iteration's plan sees the
  // concrete kept work.
  rejectionHistory: PlannerRejectionFeedback[];
  // The cross-loop convergence state — read by the convergence stage, returned in the
  // LOOPBACK so the next iteration carries the updated counter.
  convergenceState: ConvergenceState;
  // The previous iteration's findings — fed to the convergence stage as the prior; the
  // returned LOOPBACK carries this iteration's findings as the next iteration's prior.
  priorFindings: Finding[];
  loopCount: number;
}

/**
 * The iteration's outcome — either a TERMINAL outcome the outer loop returns after
 * `finalize`, or a LOOPBACK with the updated convergence state + new prior findings.
 */
export type SubtaskIterationResult =
  | { kind: "terminal"; outcome: SubtaskLoopOutcome }
  | {
      kind: "loopback";
      convergenceState: ConvergenceState;
      priorFindings: Finding[];
    };

/**
 * Run ONE iteration of the spec-implementation loop: budget/window preflight → plan →
 * per-task inner loop → spec-gate → auditor → post-audit findings (demo + design
 * oracle) → triage → convergence. Returns a TERMINAL outcome the outer loop should
 * finalize, or a LOOPBACK with the updated state for the next iteration.
 *
 * This is a pure extraction of the inline body of `runSubtaskLoop`'s `while (true)`
 * — same calls, same order, same terminal writes (`markPlannerFailed` /
 * `markPlannerPassed`), same event emits. The extraction is BEHAVIOR-PRESERVING; the
 * existing subtask-loop test family pins this.
 */
export async function runSubtaskIteration(ctx: SubtaskIterationContext): Promise<SubtaskIterationResult> {
  const { input, costCtx, appendEvent, plannerTaskId, planCtx, creditState, posture, convergencePolicy, loopCount } =
    ctx;

  // PER-ITERATION BUDGET GATE (audit §3.7a): stops an in-flight cohort the instant
  // it crosses the ceiling (or the gate fails closed); halt PARKS the spec, requeueable.
  const budgetPause = await checkIterationBudget(input);
  if (budgetPause !== null) {
    // Audit finding #4: pause routes through `markPlannerFailed` (atomic row +
    // `task.failed`) — the sister site PR #705's six-site lift missed.
    await emitBudgetPause(input, appendEvent, planCtx, budgetPause);
    return { kind: "terminal", outcome: budgetPausedOutcome(budgetPause, loopCount) };
  }
  const windowOutcome = await checkWindowPreflight(input, appendEvent, plannerTaskId, loopCount, creditState);
  if (windowOutcome !== null) {
    // task #46: atomic FAILED terminal pair (row + `task.failed`) — same shape
    // as the writer stage's `failureKind: "window_exhausted"` terminal.
    await markPlannerFailed(planCtx, "window_exhausted");
    return { kind: "terminal", outcome: { ...windowOutcome, loopCount } };
  }
  const plan = await runPlannerStage({
    pool: input.pool,
    // task #21: writer threaded so the finalize guard's FAILED terminal rides ONE txn via `updateTaskWithEvent`.
    writer: input.runStateWriter,
    costCtx,
    adapter: input.adapters.planner,
    spec: input.context,
    runId: input.context.runId,
    workspacePath: input.context.workspacePath,
    plannerTaskId,
    appendEvent,
    attempt: loopCount + 1,
    rejectionHistory: ctx.rejectionHistory,
    buildUsage: input.costHooks?.buildPlannerUsage,
  });

  // Per-task inner loop: WRITER → FAST GATE → CHECKER, for every subtask in order.
  const sequence = await runSubtaskSequence({ input, costCtx, appendEvent, plan, plannerTaskId });
  if (sequence.kind === "window_exhausted") {
    await markPlannerFailed(planCtx, "window_exhausted");
    return { kind: "terminal", outcome: { ...sequence.outcome, loopCount } };
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
    specMode: input.context.specMode,
    appendEvent,
    buildUsage: input.costHooks?.buildAuditorUsage,
  });
  findings.push(...audit.findings);

  // POST-AUDITOR findings: demo-run gate (policy-enabled) + WS-D4 design-oracle
  // gate (wired actor + existing contract). Both merge into the SAME triage input.
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
      // Audit round-2 H1: thread the spec mode so the designOracle prompt gets the
      // seeded-mode tail block (mirrors checker/auditor — PR #708). Demo-run does
      // not take specMode today (its "does it work" gate is mode-agnostic).
      ...(input.context.specMode !== undefined && { specMode: input.context.specMode }),
      appendEvent,
    })),
  );

  // critic-arc R1 #4 fix: SUCCESS terminations emit `task.completed` via the
  // atomic terminal pair (task #46) so the planner row isn't silent on the audit trail.
  if (findings.length === 0) {
    await markPlannerPassed(planCtx);
    return {
      kind: "terminal",
      outcome: { kind: "passed", plannerTaskId, subtasks: plan.subtasks, newSpecs: [], loopCount },
    };
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
  const newSpecs: NewSpecRequest[] = triage.routing.newSpecs.map((r) => routedToNewSpec(r));

  // TRIAGE → PASSED: every finding became a NEW spec (none kept here).
  if (triage.routing.outcome === "passed") {
    await markPlannerPassed(planCtx);
    return {
      kind: "terminal",
      outcome: { kind: "passed", plannerTaskId, subtasks: plan.subtasks, newSpecs, loopCount },
    };
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
    priorFindings: ctx.priorFindings,
    state: ctx.convergenceState,
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
  const nextConvergenceState = convergence.state;

  if (convergence.decision === "halt") {
    // HALT by the agent's INTELLIGENT escalation verdict (a human decision/blocker
    // /dead-end), NOT a count. `escalationReason` is the human-actionable reason.
    const haltReason = convergence.escalationReason === "" ? convergence.reasoning : convergence.escalationReason;
    await appendEvent("convergence.stalled", {
      runId: input.context.runId,
      consecutiveStalls: convergence.state.consecutiveStalls,
      reason: haltReason,
    });
    // task #46: atomic FAILED terminal pair; row lands `status=failed` with
    // `failureKind=convergence_stalled` (was `done/rejected_by_auditor` + glued
    // `task.failed` event; dashboard already treats both as "failed").
    await markPlannerFailed(planCtx, "convergence_stalled", haltReason);
    return {
      kind: "terminal",
      outcome: {
        kind: "convergence_stalled",
        loopCount,
        consecutiveStalls: convergence.state.consecutiveStalls,
        reason: haltReason,
      },
    };
  }
  if (convergence.decision === "pass") {
    // Velocity policy: defer the mild kept leftovers as specs and ALLOW the pass.
    const deferred: NewSpecRequest[] = triage.routing.tasksHere.map((r) => routedToNewSpec(r));
    await markPlannerPassed(planCtx);
    return {
      kind: "terminal",
      outcome: {
        kind: "passed",
        plannerTaskId,
        subtasks: plan.subtasks,
        newSpecs: [...newSpecs, ...deferred],
        loopCount,
      },
    };
  }

  // progress → loop. Seed the planner with the kept work as steering + carry the
  // current findings forward as the next loop's prior. `rejectionHistory` is mutated
  // in place (same shape as the inline body); `convergenceState` + `priorFindings`
  // are returned in the LOOPBACK for the next iteration.
  ctx.rejectionHistory.push(triageToRejection(triage.routing.tasksHere, plan.subtasks));
  return {
    kind: "loopback",
    convergenceState: nextConvergenceState,
    priorFindings: findings,
  };
}
