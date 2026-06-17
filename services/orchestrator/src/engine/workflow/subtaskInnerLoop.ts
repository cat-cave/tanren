// The per-task INNER LOOP of the spec-implementation loop (docs/roadmap/
// spec-loop-redesign.md): WRITER → FAST GATE (tier-1, BEFORE the checker) → CHECKER,
// for every subtask in order. Split out of subtaskLoop.ts so each module stays under
// the 500-line architecture cap.
//
// NO ITERATION CAP (apex v35 — intelligent non-convergence detection). The writer
// iterates UNBOUNDED while it is making PROGRESS — a fast-gate failure or a checker
// incompleteness loops back to the WRITER (fed the EXACT failing error as steering) for
// as many rounds as it keeps changing/shrinking the problem. The 1000 → 500 → 100 → 1
// type-error trajectory is genuine progress at EVERY step even though each step still
// fails — so a flat `maxWriterIterPerSubtask=5` cap (the old bound) would kill a
// self-healing writer mid-convergence. Instead the shared `convergenceDetector` decides:
// the loop continues while the rejection reason OR the produced diff keeps changing, and
// stops ONLY at a FIXED POINT (the writer produces the IDENTICAL diff AND gets the
// IDENTICAL rejection with no new information). On a fixed point the residual
// incompleteness is surfaced as a P0 FINDING (fed to the spec-level triage/convergence,
// where the intelligent escalation judgment lives) — NEVER a retry-cap halt.
import { createHash, randomUUID } from "node:crypto";
import type { PlanAnswer, PlanSubtask } from "../answerers/schemas/index.js";
import type { Finding } from "../contracts/findings.js";
import type { GateOutcome } from "./gate/index.js";
import { runCheckerStage, runWriterStage } from "./subtaskStages.js";
import { type SubtaskCostContext } from "./subtaskCost.js";
import { assessStructuralProgress, type AttemptSignature } from "./convergenceDetector.js";
import type { AppendEvent, SubtaskLoopInput, SubtaskLoopOutcome } from "./subtaskLoop.js";

// The result of walking a plan's subtasks (per-task WRITER → FAST GATE → CHECKER):
// `passed` with any per-task incompleteness findings (a task that could not complete
// within the writer-iteration bound yields a P0 finding fed to triage — NOT a halt), or
// a window-exhausted halt (a writer whose §4.3 usage window was spent mid-call).
export type SubtaskSequenceResult =
  | { kind: "passed"; taskFindings: Finding[] }
  | { kind: "window_exhausted"; outcome: Extract<SubtaskLoopOutcome, { kind: "window_exhausted" }> };

// runSubtaskSequence walks the plan in order. Per subtask: WRITER → FAST GATE (tier-1,
// BEFORE the checker; a fail loops straight back to the writer) → CHECKER (completeness
// findings; any finding loops back to the writer) → task done. UNBOUNDED while making
// PROGRESS — at a FIXED POINT (identical diff + identical rejection) the residual
// incompleteness becomes a P0 finding (fed to triage/convergence), never a retry-cap halt.
export async function runSubtaskSequence(args: {
  input: SubtaskLoopInput;
  costCtx: SubtaskCostContext;
  appendEvent: AppendEvent;
  plan: PlanAnswer;
  plannerTaskId: string;
}): Promise<SubtaskSequenceResult> {
  const { input, costCtx, appendEvent, plan, plannerTaskId } = args;
  const taskFindings: Finding[] = [];
  for (const subtask of plan.subtasks) {
    const result = await runOneSubtask({ input, costCtx, appendEvent, plannerTaskId, subtask });
    if (result.kind === "window_exhausted") {
      return result;
    }
    if (result.kind === "incomplete") {
      taskFindings.push(result.finding);
    }
  }
  return { kind: "passed", taskFindings };
}

type OneSubtaskResult =
  | { kind: "complete" }
  | { kind: "incomplete"; finding: Finding }
  | { kind: "window_exhausted"; outcome: Extract<SubtaskLoopOutcome, { kind: "window_exhausted" }> };

// Run a single subtask's WRITER → FAST GATE → CHECKER inner loop, UNBOUNDED while making
// PROGRESS. A gate fail or a checker incompleteness loops back to the writer IMMEDIATELY
// (the fast gate runs BEFORE the checker, so a broken tree never burns a checker call),
// fed the EXACT failing error as steering. The loop continues for as many rounds as the
// rejection reason OR the produced diff keeps changing (the writer is still working the
// problem — 1000 → 1 errors is progress at every step). It stops ONLY at a FIXED POINT
// (the writer reproduces the IDENTICAL diff AND gets the IDENTICAL rejection — no new
// information), where the residual incompleteness is surfaced as a P0 FINDING that
// triage/convergence reason over (the intelligent escalation judgment lives there).
async function runOneSubtask(args: {
  input: SubtaskLoopInput;
  costCtx: SubtaskCostContext;
  appendEvent: AppendEvent;
  plannerTaskId: string;
  subtask: PlanSubtask;
}): Promise<OneSubtaskResult> {
  const { input, costCtx, appendEvent, plannerTaskId, subtask } = args;
  let lastReason = "";
  // The attempt history (oldest→newest) the shared convergence detector reasons over: each
  // iteration's REJECTION reason (the failure signature) + the writer's produced DIFF hash
  // (the work signature). The loop keeps going while either changes (progress); it stops at
  // a FIXED POINT (identical rejection + identical diff). NO iteration count gates it.
  const attempts: AttemptSignature[] = [];
  let iter = 0;
  for (;;) {
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
      prompt: writerPromptFor(input, subtask, iter, lastReason),
      timeoutMs: input.timeoutMs,
      baseSha: input.context.baseSha,
      appendEvent,
      buildUsage: input.costHooks?.buildWriterUsage,
    });
    if (writerOutcome.kind === "window_exhausted") {
      return {
        kind: "window_exhausted",
        outcome: {
          kind: "window_exhausted",
          loopCount: 0,
          provider: input.adapters.writer.cli,
          slot: "writer",
          usedPercent: 100,
          resetsAt: new Date().toISOString(),
        },
      };
    }
    if (writerOutcome.kind === "failed") {
      // A hard writer failure (crashed / timed out): retry the writer (the diff is
      // partial). A crash with no usable diff has no work signature — progress keys off
      // the rejection reason changing. At a fixed point (the SAME crash repeatedly) the
      // detector surfaces the residual finding instead of re-driving forever.
      lastReason = `writer ${writerOutcome.failureKind} mid-subtask`;
      const stuck = recordAttemptAndCheckFixedPoint(attempts, lastReason);
      if (stuck !== undefined) return stuck(subtask, iter + 1);
      iter += 1;
      continue;
    }
    const diffSignature = hashWork(writerOutcome.writer.diff);

    // FAST GATE (tier-1: fmt/lint/typecheck) — BEFORE the checker. A fail loops straight
    // back to the writer (do NOT burn a checker call on a known-broken tree), fed the
    // EXACT failing tier/step/output as steering (`gateReason`) so it fixes the right thing.
    if (input.runGate !== undefined) {
      const gate = await input.runGate({ when: "per_iteration", taskId: writeTaskId });
      if (!gate.passed) {
        lastReason = gateReason(gate);
        // PROGRESS while the gate failure OR the produced diff keeps changing (a shrinking
        // error count is a different `outputTail` → progress); STOP at a fixed point.
        const stuck = recordAttemptAndCheckFixedPoint(attempts, lastReason, diffSignature);
        if (stuck !== undefined) return stuck(subtask, iter + 1);
        iter += 1;
        continue;
      }
    }

    // CHECKER (completeness findings). No findings ⇒ task complete; any finding ⇒ back
    // to the writer with the gaps as steering.
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
      writerResult: writerOutcome.writer,
      ...(input.context.baseSha === undefined ? {} : { baseSha: input.context.baseSha }),
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
      timeoutMs: input.timeoutMs,
      appendEvent,
      buildUsage: input.costHooks?.buildCheckerUsage,
      // §3.1: the host-side entity-risk producer (shells `sem` read-only on the
      // runner). Absent on unit paths ⇒ the checker degrades to `unknown`.
      ...(input.entityRiskProducer !== undefined && { entityRiskProducer: input.entityRiskProducer }),
    });
    if (decision.kind === "pass") {
      return { kind: "complete" };
    }
    // EMPTY-INCREMENTAL-DIFF (v35): a reject over an EMPTY `baselineSha → HEAD` diff is
    // NOT reworkable — re-driving the writer is futile (it correctly adds nothing → the
    // diff stays empty → the same finding). Surface the residual finding straight to
    // triage/convergence INSTEAD of re-entering the writer.
    if (!decision.reworkable) {
      return {
        kind: "incomplete",
        finding: {
          id: `task-incomplete-${subtask.index}`,
          severity: "P0",
          title: `Subtask ${subtask.index} reported incomplete with no incremental change to grow`,
          body: decision.reason,
        },
      };
    }
    lastReason = decision.reason;
    // PROGRESS while the checker's incompleteness reason OR the produced diff keeps changing
    // (the writer is still closing the gaps); STOP only at a FIXED POINT (the identical
    // checker rejection over the identical diff — the writer has stopped changing anything).
    const stuck = recordAttemptAndCheckFixedPoint(attempts, lastReason, diffSignature);
    if (stuck !== undefined) return stuck(subtask, iter + 1);
    iter += 1;
  }
}

// Record the latest writer attempt's signature (its rejection reason + produced-diff hash)
// onto the running history, then ask the shared detector whether the loop is at a FIXED
// POINT (this attempt indistinguishable from the prior — identical rejection AND identical
// diff). Returns `undefined` while making PROGRESS (the loop continues, UNBOUNDED), or a
// builder for the residual P0 `incomplete` result when stuck (no count — the structural
// fixed point IS the stop condition).
function recordAttemptAndCheckFixedPoint(
  attempts: AttemptSignature[],
  rejectionReason: string,
  diffSignature?: string,
): ((subtask: PlanSubtask, rounds: number) => OneSubtaskResult) | undefined {
  attempts.push({
    failureSignature: rejectionReason,
    ...(diffSignature !== undefined && { workSignature: diffSignature }),
  });
  if (assessStructuralProgress(attempts) !== "fixed_point") return undefined;
  return (subtask, rounds) => ({
    kind: "incomplete",
    finding: {
      id: `task-incomplete-${subtask.index}`,
      severity: "P0",
      title: `Subtask ${subtask.index} reached a fixed point after ${rounds} writer iteration(s) — identical output, identical rejection`,
      body:
        rejectionReason === ""
          ? `Subtask "${subtask.title}" did not reach completeness and stopped changing.`
          : rejectionReason,
    },
  });
}

// A stable hash of the writer's produced diff — the WORK signature the convergence
// detector keys "the writer did something different" off. Identical diff text ⇒ identical
// hash ⇒ no work progress this iteration.
function hashWork(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

// Render a failed gate into the writer-rework steering string: a header naming the
// failing tier/step/exit, plus the failed step's captured output tail (the ACTUAL
// type/lint/test error) so the writer fixes the real failure instead of re-running the
// gate to rediscover it. Shared by the fast-tier (per_iteration) writer steering here
// AND the merge-tier (pre_merge) self-heal re-entry (`mergeGateRejection`), so every
// gate point feeds the writer the same actionable failure content.
export function gateReason(gate: Extract<GateOutcome, { passed: false }>): string {
  const { failure } = gate;
  const exit = failure.exitCode === null ? "no exit code" : `exit ${failure.exitCode}`;
  const header = `gate tier "${failure.tier}" (${failure.when}) failed at step "${failure.failedStep}" with ${exit}`;
  // Append the failed step's captured output (apex pre-run §7.4): the gate already
  // captured up to 4KB of the step's stderr/stdout in `outputTail`. Feeding it to the
  // writer-rework prompt shows the ACTUAL error (the failing type/lint/test message)
  // so the writer fixes it directly instead of re-running the gate to rediscover it.
  const failedStep = failure.steps.find((step) => step.name === failure.failedStep) ?? failure.steps.at(-1);
  const outputTail = failedStep?.outputTail.trim() ?? "";
  return outputTail === "" ? header : `${header}\nGate output (last lines):\n${outputTail}`;
}

// A standing toolchain instruction prepended to every writer prompt.
const WRITER_TOOLCHAIN_INSTRUCTION =
  "Declare real, published devDependencies and a real lockfile. NEVER create local " +
  "workspace stub packages, `workspace:*` placeholders, or fake binaries for typescript/eslint/vitest " +
  "or any toolchain — use the real published packages.";

// How the writer's change will be GRADED (spec-loop redesign §WRITER, workstream 1).
// Steers the writer to satisfy the gate on the first pass: run the fast deterministic
// gate (fmt/lint/typecheck) BEFORE finishing — a fast-gate failure loops straight back
// to it — then names the CHECKER (completeness) + AUDITOR (quality) bars it is judged on.
const WRITER_GRADING_INSTRUCTION =
  "How your change will be graded — satisfy these BEFORE you finish: a FAST " +
  "deterministic gate runs first (formatting, lint, typecheck) — RUN it yourself " +
  "(the project's fmt/lint/typecheck commands) and make it pass before you stop, " +
  "since a fast-gate failure loops straight back to you before any reviewer. Then a " +
  "CHECKER judges whether your change COMPLETES the subtask intent + every relevant " +
  "acceptance criterion (leave it complete and self-contained), and an AUDITOR " +
  "reviews quality/security/perf (write correct, secure, clean code).";

function writerPromptFor(input: SubtaskLoopInput, subtask: PlanSubtask, iter: number, lastReason: string): string {
  const criteria =
    input.context.acceptanceCriteria.length > 0
      ? ["", "Acceptance criteria:", ...input.context.acceptanceCriteria.map((criterion) => `- ${criterion}`)]
      : [];
  // On a re-iteration (gate fail / checker incompleteness) the prior reason steers the
  // writer at the concrete gap before it spends the iteration.
  const rework =
    iter > 0 && lastReason !== "" ? ["", `Previous attempt was rejected: ${lastReason}`, "Address it directly."] : [];
  // WS-D2 (native design subsystem): the project's rendered design block for its HEAD
  // `DesignContract` — persona-scoped, behavior-linked, domain-general. Present ⇒ the build
  // honors the design (the no-handoff loop); ABSENT ⇒ the project has no design contract (a real
  // empty state) and the writer simply gets no design block — NEVER a fabricated default.
  const design = input.context.designContextBlock === undefined ? [] : ["", input.context.designContextBlock];
  return [
    `Subtask [${subtask.index}]: ${subtask.title}`,
    `Intent: ${subtask.intent}`,
    `Behaviors: ${subtask.behaviorIds.join(", ") || "(none)"}`,
    "",
    `Spec: ${input.context.specTitle}`,
    input.context.specDescription,
    ...criteria,
    ...design,
    ...rework,
    "",
    WRITER_TOOLCHAIN_INSTRUCTION,
    "",
    WRITER_GRADING_INSTRUCTION,
  ].join("\n");
}
