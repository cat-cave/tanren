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
// HALT RULES (the redesign's core): NO retry-cap / rerun limit / timeout HALT. The ONLY
// halts are (a) convergence stall (the convergence answerer, after N CONSECUTIVE stalls —
// a stall counter, NOT a retry counter) and (b) budget exhaustion (handled at the
// project/walker level, OUTSIDE this loop). A P0 finding, a failed gate, an incomplete
// task are LOOPBACKS, not halts.
//
// SHAPE (audit round-2 N2): this file is the THIN OUTER ORCHESTRATOR — it builds the
// loop context (planner task row, append-event closure, cost ctx, terminal-write ctx)
// and drives `runSubtaskIteration` (sibling module) until it returns a TERMINAL
// outcome. Each iteration's discrete phases (plan → write+gate inner loop → check →
// audit → triage → convergence) live in `runSubtaskIteration.ts`, where the function
// also stays under the 220-line function cap on its own. Per-stage detail lives in
// subtaskStages.ts / auditorStage.ts / loopStages.ts; cost in subtaskCost.ts;
// task-row persistence in subtaskTasks.ts.
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
  DEFAULT_AUDIT_POSTURE,
  DEFAULT_CONVERGENCE_POLICY,
} from "../config/shared.js";
import type { SpecMode } from "../state/spec.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import { type Finding } from "../contracts/findings.js";
import type { CostRecorder } from "../costs/index.js";
import type { EntityMapProduction } from "../oracle/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import type { GateOutcome } from "./gate/index.js";
import type { PlannerRejectionFeedback, PlannerSpecContext } from "./planner/planner.js";
import { type CreditState, observeRunAccounting } from "./subtaskAccounting.js";
import { buildSubtaskCostContext, type SubtaskCostContext } from "./subtaskCost.js";
import type { RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import { insertPlannerTask } from "./subtaskTasks.js";
import { type ConvergenceState } from "./loopPolicy.js";
import { buildPlannerTerminalContext } from "./subtaskLoopHelpers.js";
import { type TriageSpecValidator } from "./loopFindings.js";
import { runSubtaskIteration } from "./runSubtaskIteration.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("subtask-loop");

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

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
  /**
   * REQUIRED (audit finding H3 sweep): every stage's terminal row + event pair
   * rides the atomic seam through this writer — no fallback. Production wires
   * the always-returning `runStateWriterFromEnv`; tests wire the
   * `InMemoryRunStateWriter` fixture.
   */
  runStateWriter: RunStateWriter;
  recorder: CostRecorder;
  adapters: SubtaskLoopAdapters;
  context: PlannerSpecContext & {
    runId: string;
    specId: string;
    projectId: string;
    // v68: runs.org_id (NOT NULL); stamped on every loop event + cost record.
    orgId: string;
    workspacePath: string;
    baseSha?: string;
    // WS-D2 (native design subsystem): the rendered design block for the project's HEAD
    // `DesignContract` (persona-scoped, behavior-linked, domain-general). Injected into the
    // writer prompt so the build honors the design. Absent ⇒ no design contract ⇒ no block.
    designContextBlock?: string;
    // Task #86 (v64 root cause): the spec's writer-prompt MODE — selects the
    // standing instructions `writerPromptFor()` emits AND the seeded-mode tail
    // block on the checker/auditor prompts. `specialize_seed` (greenfield scaffold
    // spec post-PR-G; composed seed in place + proven green, touch ONLY product-
    // identity surfaces) vs `from_scratch` (brownfield/legacy default). Absent ⇒
    // DEFAULT_SPEC_MODE (`from_scratch`).
    specMode?: SpecMode;
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
      // The new DAG specs triage emitted (routed-to-spec + velocity-deferred kept items).
      // The workstream-1 spec-creating caller materializes these; empty when none.
      newSpecs: ReadonlyArray<NewSpecRequest>;
      loopCount: number;
    }
  | {
      // SPEC-LOOP REDESIGN: replaces `retry_budget_exhausted`. The convergence answerer
      // reported N CONSECUTIVE stalls — a human action is the genuine next step.
      kind: "convergence_stalled";
      loopCount: number;
      consecutiveStalls: number;
      reason: string;
    }
  | { kind: "halted"; loopCount: number; reason: string }
  | {
      // BUDGET PAUSE (audit §3.7a): the project crossed the configured ceiling (or the
      // gate must fail closed) DURING this in-flight run — per-iteration check stops an
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
  const { runId, specId, projectId, orgId } = input.context;
  const appendEvent: AppendEvent = async (eventType, payload, taskId) => {
    await input.eventStore.append({ runId, specId, projectId, orgId, taskId, eventType, payload });
    input.onEvent?.({ eventType, taskId });
  };
  const costCtx: SubtaskCostContext = buildSubtaskCostContext(
    {
      recorder: input.recorder,
      runId,
      specId,
      projectId,
      orgId,
      captureRealProviderCost: input.captureRealProviderCost,
    },
    appendEvent,
  );

  const plannerTaskId = `task_${randomUUID()}`;
  const creditState: CreditState = { atStart: null };
  // Default: BALANCED posture (block on P0/P1, park for a human); autonomous-posture
  // projects set it via the governance API.
  const posture = input.auditPosture ?? DEFAULT_AUDIT_POSTURE;
  const convergencePolicy = input.convergencePolicy ?? DEFAULT_CONVERGENCE_POLICY;

  // finalize: run-end accounting + cost reconcile through EVERY return — token
  // accounting is a MANDATORY invariant (docs/architecture/autonomy-engine.md —
  // "disjoint typed buckets"), so a THROWN accounting seam MUST NOT be silently
  // swallowed. Codex critic #18: the prior implementation logged and preserved the
  // outcome, so a run that would have PASSED could complete `passed` with a broken
  // accounting seam — a silent-pass violating the invariant. The fix:
  //   1. Emit the LOUD durable `usage.accounting_failed` event (fail-tier severity
  //      — reaches operator channels via the default route) with the runId + the
  //      pre-transform outcome + a bounded, secret-free detail.
  //   2. DEMOTE a `passed` outcome to `halted` so downstream `nonPassDetailFor`
  //      routes the run through the non-pass finalize path — a re-drive, not a
  //      silent complete. Every other kind is already non-pass (halted /
  //      convergence_stalled / budget_paused / window_exhausted) — preserve it,
  //      but the loud event still fires so the accounting gap is visible.
  const finalize = async (outcome: SubtaskLoopOutcome): Promise<SubtaskLoopOutcome> => {
    try {
      await observeRunAccounting(input, appendEvent, plannerTaskId, creditState);
      return outcome;
    } catch (error) {
      const detail = boundedErrorDetail(error);
      const demoted = outcome.kind === "passed";
      await appendEvent(
        "usage.accounting_failed",
        {
          runId: input.context.runId,
          priorOutcomeKind: outcome.kind,
          outcomeDemoted: demoted,
          detail,
          reason: "run-end accounting seam threw",
        },
        plannerTaskId,
      );
      log.error(
        "run-end mandatory accounting seam THREW; outcome demoted to halted (no silent-pass)",
        { runId: input.context.runId, outcomeKind: outcome.kind, demoted },
        error,
      );
      if (demoted) {
        return {
          kind: "halted",
          loopCount: outcome.loopCount,
          reason: `accounting_failed: ${detail}`,
        };
      }
      return outcome;
    }
  };

  await insertPlannerTask(input.pool, input.context.runId, plannerTaskId, input.adapters.planner, input.runStateWriter);
  await appendEvent("task.started", { taskKind: "plan" }, plannerTaskId);
  await appendEvent("planner.started", { taskKind: "plan" }, plannerTaskId);

  // task #46: pre-bound atomic-terminal context the planner-task terminal sites use.
  const planCtx = buildPlannerTerminalContext(input, plannerTaskId);
  const rejectionHistory: PlannerRejectionFeedback[] = [...(input.seedRejections ?? [])];
  // The cross-loop convergence state — the SOLE loop bound (NOT a retry counter). A
  // `progress`/`velocity_defer` resets it; a `stalled` increments; N consecutive halts.
  let convergenceState: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
  let priorFindings: Finding[] = [];
  let loopCount = 0;

  // Audit round-2 N2: the per-iteration body (plan → write+gate inner loop → check →
  // audit → triage → convergence) lives in `runSubtaskIteration.ts`. This outer loop
  // is a thin orchestrator — drive iterations until one returns TERMINAL, finalize
  // its outcome, return. `rejectionHistory` is mutated in place by the iteration on a
  // progress loopback (same shape as the previous inline version); `convergenceState`
  // + `priorFindings` are carried through the LOOPBACK so the next iteration sees
  // the updated state.
  while (true) {
    const result = await runSubtaskIteration({
      input,
      costCtx,
      appendEvent,
      plannerTaskId,
      planCtx,
      creditState,
      posture,
      convergencePolicy,
      rejectionHistory,
      convergenceState,
      priorFindings,
      loopCount,
    });
    if (result.kind === "terminal") {
      return await finalize(result.outcome);
    }
    convergenceState = result.convergenceState;
    priorFindings = result.priorFindings;
    loopCount += 1;
  }
}

// Codex critic #18: shape a caught accounting error into a bounded, secret-free
// diagnostic tail for the `usage.accounting_failed` payload — `Error.message` when
// available, else a stringified fallback, capped at 500 chars so an accidentally
// verbose message never bloats the durable event.
function boundedErrorDetail(error: unknown): string {
  const raw = error instanceof Error && error.message !== "" ? error.message : String(error);
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}
