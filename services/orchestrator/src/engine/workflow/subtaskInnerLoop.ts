// The per-task INNER LOOP of the spec-implementation loop (docs/roadmap/
// spec-loop-redesign.md): WRITER → FAST GATE (tier-1, BEFORE the checker) → CHECKER,
// for every subtask in order, bounded by `maxWriterIterPerSubtask` PER TASK. Split out
// of subtaskLoop.ts so each module stays under the 500-line architecture cap.
//
// A gate fail or a checker incompleteness loops back to the WRITER immediately (the
// fast gate runs BEFORE the checker, so a broken tree never burns a checker call). On
// budget exhaustion of the per-task writer iterations the residual incompleteness is a
// P0 FINDING (fed to the spec-level triage/convergence) — NEVER a retry-cap halt.
import { randomUUID } from "node:crypto";
import type { PlanAnswer, PlanSubtask } from "../answerers/schemas/index.js";
import type { Finding } from "../contracts/findings.js";
import type { GateOutcome } from "./gate/index.js";
import { runCheckerStage, runWriterStage } from "./subtaskStages.js";
import { type SubtaskCostContext } from "./subtaskCost.js";
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
// findings; any finding loops back to the writer) → task done. Bounded by
// `maxWriterIterPerSubtask` PER TASK — on exhaustion the residual incompleteness becomes
// a P0 finding (fed to triage/convergence), never a retry-cap halt.
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

// Run a single subtask's WRITER → FAST GATE → CHECKER inner loop, bounded by
// `maxWriterIterPerSubtask`. A gate fail or a checker incompleteness loops back to the
// writer IMMEDIATELY (the fast gate runs BEFORE the checker, so a broken tree never
// burns a checker call). On budget exhaustion of the per-task writer iterations the
// residual incompleteness is a P0 FINDING (triage/convergence own the loop bound).
async function runOneSubtask(args: {
  input: SubtaskLoopInput;
  costCtx: SubtaskCostContext;
  appendEvent: AppendEvent;
  plannerTaskId: string;
  subtask: PlanSubtask;
}): Promise<OneSubtaskResult> {
  const { input, costCtx, appendEvent, plannerTaskId, subtask } = args;
  const maxIter = input.escapeHatches.maxWriterIterPerSubtask;
  let lastReason = "";
  for (let iter = 0; iter < maxIter; iter += 1) {
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
      // partial), within the per-task bound.
      lastReason = `writer ${writerOutcome.failureKind} mid-subtask`;
      continue;
    }

    // FAST GATE (tier-1: fmt/lint/typecheck) — BEFORE the checker. A fail loops straight
    // back to the writer (do NOT burn a checker call on a known-broken tree).
    if (input.runGate !== undefined) {
      const gate = await input.runGate({ when: "per_iteration", taskId: writeTaskId });
      if (!gate.passed) {
        lastReason = gateReason(gate);
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
    lastReason = decision.reason;
  }
  // The per-task writer-iteration bound is spent and the task is still incomplete: NOT
  // a halt — surface a P0 FINDING that triage/convergence reason over.
  return {
    kind: "incomplete",
    finding: {
      id: `task-incomplete-${subtask.index}`,
      severity: "P0",
      title: `Subtask ${subtask.index} still incomplete after ${maxIter} writer iterations`,
      body: lastReason === "" ? `Subtask "${subtask.title}" did not reach completeness.` : lastReason,
    },
  };
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
  return [
    `Subtask [${subtask.index}]: ${subtask.title}`,
    `Intent: ${subtask.intent}`,
    `Behaviors: ${subtask.behaviorIds.join(", ") || "(none)"}`,
    "",
    `Spec: ${input.context.specTitle}`,
    input.context.specDescription,
    ...criteria,
    ...rework,
    "",
    WRITER_TOOLCHAIN_INSTRUCTION,
    "",
    WRITER_GRADING_INSTRUCTION,
  ].join("\n");
}
