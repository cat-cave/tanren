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
import { type AttemptSignature, decideConvergence, fixedPointRuleJudgment } from "./convergenceDetector.js";
import { canonicalizeFailureSignature } from "./convergenceSignatureCanonical.js";
import { writerPromptFor } from "./subtaskWriterPrompt.js";
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
// fed the EXACT failing error as steering. A hard writer failure (crash / TIMEOUT) loops
// back too — but never as an IDENTICAL re-run: the next attempt carries change-approach
// steering (commit the partial progress, do the smallest next increment) and the writer's
// PARTIAL diff is recorded as the work signature, so the apex-v36 "timed out mid-subtask,
// identical output" loop now reads as a different (informed) attempt or converges. The
// loop continues for as many rounds as the rejection reason OR the produced diff keeps
// changing (the writer is still working the problem — 1000 → 1 errors is progress at every
// step). It stops ONLY at a FIXED POINT (the writer reproduces the IDENTICAL diff AND gets
// the IDENTICAL rejection — no new information), where the residual incompleteness is
// surfaced as a P0 FINDING that triage/convergence reason over (the intelligent escalation
// judgment lives there).
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
  // a FIXED POINT (identical rejection + identical diff). NO iteration count gates it. ONLY
  // genuine WORK signals (a checker reject, a gate fail, a timeout that produced a partial
  // diff) feed this — a writer CRASH (a non-deterministic process death with no clean output)
  // does NOT (it carries no "the work is wrong" information; it is re-driven as transient).
  const attempts: AttemptSignature[] = [];
  // A writer CRASH is TRANSIENT, exactly like an answerer stall (loopStageRecovery.ts): the
  // process died with no usable output, so the next attempt simply re-runs. Crashes are
  // tracked in their OWN streak history — NOT mixed into the work-convergence `attempts` —
  // so a crash (or two) never trips the work fixed-point. The streak escalates ONLY when the
  // writer crashes on EVERY consecutive re-drive with no clean run in between (a genuinely
  // wedged writer/runner), and RESETS the moment the writer completes a run (any non-crash
  // outcome). This is the crash analogue of the stall recovery: a crash-then-succeed reads
  // as progress and never escalates; a crash-on-every-attempt converges to a loud fixed point.
  const crashAttempts: AttemptSignature[] = [];
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
    if (writerOutcome.kind === "failed" && writerOutcome.failureKind === "crashed") {
      // A writer CRASH is TRANSIENT (the codex exec died with a nonzero exit / a transient
      // SSH-connect blip / no parseable output) — it carries NO "the work is wrong" signal,
      // so it must NEVER feed the WORK convergence (`attempts`): 2 identical crashes are not a
      // proven dead-end, they are 2 transient failures to RE-DRIVE (the v39 finding — a crash
      // mis-read as a work fixed-point → spurious needs_attention). It is the writer analogue
      // of an answerer stall: re-run the SAME subtask. The crash is recorded into its OWN
      // streak (`crashAttempts`) keyed on the STABLE crash signature, so a writer that crashes
      // on EVERY consecutive re-drive (a genuinely wedged writer/runner — no clean run ever)
      // still converges to a LOUD fixed point and escalates; a crash-then-succeed never does.
      lastReason = writerFailureReason("crashed");
      const wedged = await recordCrashAndCheckWedged(crashAttempts, input.adapters.writer.cli);
      if (wedged !== undefined) return wedged(subtask);
      iter += 1;
      continue;
    }
    // Any non-crash writer outcome means the writer ran cleanly enough to produce a result —
    // reset the consecutive-crash streak (a crash-then-clean-run is progress, never a wedge).
    crashAttempts.length = 0;
    if (writerOutcome.kind === "failed") {
      // A writer TIMEOUT (the only remaining hard-failure kind here). Unlike a crash, a timeout
      // CARRIES progress information — the writer ran and produced a PARTIAL diff that grows
      // attempt over attempt — so it stays in the WORK convergence. The next attempt must NOT
      // re-run the IDENTICAL subtask to the IDENTICAL timeout (the apex-v36 "timed out
      // mid-subtask, identical output" non-convergence) — it must CHANGE APPROACH. So:
      //   (1) steer the writer to change strategy (`writerFailureReason`): the subtask was too
      //       large for one call — commit the partial progress it already made, narrow to the
      //       smallest next increment, and don't restart from scratch;
      //   (2) record the PARTIAL diff as the work signature so genuine incremental progress
      //       (a growing partial diff each attempt) reads as progress, while a byte-identical
      //       partial (the writer making no headway) converges the fixed-point detector to a
      //       residual finding instead of re-driving forever. An empty partial diff has no
      //       work signature — progress then keys off the rejection reason changing.
      lastReason = writerFailureReason("timeout");
      const partial = writerOutcome.writer.diff;
      const stuck = await recordAttemptAndCheckFixedPoint(
        attempts,
        lastReason,
        partial === "" ? undefined : hashWork(partial),
      );
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
        const stuck = await recordAttemptAndCheckFixedPoint(attempts, lastReason, diffSignature);
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
      // Task #86: thread spec mode → checker's seeded-mode tail block on `specialize_seed`.
      specMode: input.context.specMode,
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
    const stuck = await recordAttemptAndCheckFixedPoint(attempts, lastReason, diffSignature);
    if (stuck !== undefined) return stuck(subtask, iter + 1);
    iter += 1;
  }
}

// Record the latest writer attempt's signature (its rejection reason + produced-diff hash)
// onto the running history, then route the escalation decision through the SHARED
// `decideConvergence` judge — NOT a raw `=== "fixed_point"` boolean (the disguised-K=2 the
// audit flagged). The writer's produced work is OBSERVABLE here (the diff hash), so a
// byte-identical diff + identical rejection is a PROVEN dead-end (no new information); the
// principled `fixedPointRuleJudgment` stands in (there is no separate "would a human help"
// answerer at this point — the checker already rendered its completeness verdict). Returns
// `undefined` while making PROGRESS (the loop continues, UNBOUNDED — a changed rejection OR a
// changed diff is progress), or a builder for the residual P0 `incomplete` result when the
// judge escalates (no count — the structural fixed point / cycle IS the stop condition).
//
// AUDIT FINDING #14 — the comparison key (`failureSignature`) is the CANONICALIZED
// rejection text (ANSI escapes / timestamps / durations / run+task+spec id refs / vitest
// summary lines / content-addressed hex stripped). The RAW `rejectionReason` is still
// surfaced verbatim to the residual finding body — only the convergence-detector
// comparison key flows through the canonicalizer. Two semantically-identical rejections
// that previously differed only in tool-reported durations or timestamps (defeating the
// fixed-point detector silently — the v64-class non-convergence) now hash equal.
async function recordAttemptAndCheckFixedPoint(
  attempts: AttemptSignature[],
  rejectionReason: string,
  diffSignature?: string,
): Promise<((subtask: PlanSubtask, rounds: number) => OneSubtaskResult) | undefined> {
  attempts.push({
    failureSignature: canonicalizeFailureSignature(rejectionReason),
    ...(diffSignature !== undefined && { workSignature: diffSignature }),
  });
  const decision = await decideConvergence(attempts, (h) =>
    fixedPointRuleJudgment(h, () =>
      rejectionReason === ""
        ? "the writer stopped changing anything and the subtask did not reach completeness"
        : rejectionReason,
    ),
  );
  if (decision.decision !== "escalate") return undefined;
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

// Record a writer CRASH onto the consecutive-crash streak, then route the escalation decision
// through the SAME shared convergence judge — but on the SEPARATE crash history, NOT the work
// history. A crash is the writer analogue of an answerer stall (loopStageRecovery.ts): it is a
// non-deterministic process death with no clean output, so it RE-DRIVES the subtask in place
// (`undefined` ⇒ keep going) and only a writer that crashes on EVERY consecutive re-drive — a
// genuinely wedged writer/runner, the IDENTICAL crash signature with no clean run in between —
// converges to a PROVEN fixed point and escalates LOUDLY (NOT a count: the streak is the
// signal, not a cap). The signature is STABLE (the writer cli's crash identity) so an
// uninterrupted run of crashes reads as a cycle while a crash-then-clean-run resets the streak
// (the caller clears `crashAttempts` on any non-crash outcome) and never escalates.
async function recordCrashAndCheckWedged(
  crashAttempts: AttemptSignature[],
  writerCli: string,
): Promise<((subtask: PlanSubtask) => OneSubtaskResult) | undefined> {
  crashAttempts.push({ failureSignature: `writer:${writerCli}:crashed` });
  const decision = await decideConvergence(crashAttempts, (h) =>
    fixedPointRuleJudgment(
      h,
      () =>
        `the ${writerCli} writer CRASHED (no clean output) on every consecutive re-drive of this subtask — ` +
        "the writer or runner is wedged (not a flake), so a human must intervene",
    ),
  );
  if (decision.decision !== "escalate") return undefined;
  return (subtask) => ({
    kind: "incomplete",
    finding: {
      id: `task-incomplete-${subtask.index}`,
      severity: "P0",
      title: `Subtask ${subtask.index} writer crashed on every consecutive re-drive — wedged, no clean output`,
      body: decision.reason,
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
//
// EVIDENCE-INSUFFICIENT (apex v57 task #64): when the gate failed because the step
// exited 0 but produced no positive proof of its declared contract (the v57 green-by-
// accident class — `tsc` over empty files, `vitest` with no tests, `playwright`
// with no browsers), prepend a SPECIFIC diagnosis NAMING the contract violation
// (e.g. "your test command exited 0 but produced 0 of 1 required tests"). This is
// what converts a v57-style 8-hour convergence loop into a 1-iteration fix: the
// writer is told the contract, not just "the gate failed".
export function gateReason(gate: Extract<GateOutcome, { passed: false }>): string {
  const { failure } = gate;
  const exit = failure.exitCode === null ? "no exit code" : `exit ${failure.exitCode}`;
  const header = `gate tier "${failure.tier}" (${failure.when}) failed at step "${failure.failedStep}" with ${exit}`;
  const evidenceDirective = evidenceInsufficientDirective(failure);
  const outputTail = failedStepOutputTail(failure);
  const parts: string[] = [header];
  if (evidenceDirective !== undefined) parts.push(evidenceDirective);
  if (outputTail !== "") parts.push(`Gate output (last lines):\n${outputTail}`);
  return parts.join("\n");
}

// The writer-steering line built from a gate failure's evidence verdict (apex v57 task
// #64). Returns undefined when the failure is the historical exit-code class (no
// evidence verdict, or the verdict is sufficient). When the failure is evidence-
// insufficient, names the contract violation precisely:
//   - junit_zero_tests        → "your test command exited 0 but produced 0 of N required tests"
//   - junit_below_threshold   → "your test command produced K of N required tests"
//   - junit_missing           → "your test command exited 0 but wrote no JUnit report to <path>"
//   - artifact_absent         → "your step exited 0 but wrote no artifact to <path>"
//   - artifact_too_small      → "your step's artifact at <path> is below the minBytes threshold"
//   - stdout_count_below_threshold → "your step's stdout did not match the required pattern K of N times"
// STACK-AGNOSTIC: the directive names the project's own declared contract; Tanren
// names no runner / tool. The class name (`gate-evidence-insufficient-<reason>`) is
// the stable id the spec-level convergence detector can dedupe across iterations.
export function evidenceInsufficientDirective(
  failure: Extract<GateOutcome, { passed: false }>["failure"],
): string | undefined {
  if (failure.failedReason !== "evidence_insufficient") return undefined;
  const ev = failure.evidence;
  if (ev === undefined || ev.sufficient) return undefined;
  const className = `gate-evidence-insufficient-${ev.reason}`;
  const reasonText = describeEvidenceReason(ev);
  return `EVIDENCE INSUFFICIENT [${className}]: ${reasonText} The step's process exited 0, but the gate requires POSITIVE proof the declared contract actually ran. Fix the test/build command so it produces the required evidence — do not patch the gate config to weaken the threshold.`;
}

// Stringify a record value safely: primitives stringify naturally, objects fall back
// to JSON so the directive never emits `[object Object]`. The harvester always writes
// primitives, but the open record type allows `unknown` — this is defense in depth.
function stringifyEvidenceValue(value: unknown): string {
  if (value === undefined || value === null) return "?";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "?";
  }
}

function describeEvidenceReason(
  ev: Extract<NonNullable<Extract<GateOutcome, { passed: false }>["failure"]["evidence"]>, { sufficient: false }>,
): string {
  const observedOf = (key: string): string => stringifyEvidenceValue(ev.observed[key]);
  const requiredOf = (key: string): string => stringifyEvidenceValue(ev.required[key]);
  switch (ev.reason) {
    case "junit_zero_tests":
      return `your test command exited 0 but ran ZERO tests (required ${requiredOf("minTests")}). The runner discovered no test files, OR the suite was filtered out — invoke your test runner so it actually executes the suite.`;
    case "junit_below_threshold":
      return `your test command ran ${observedOf("total")} of ${requiredOf("minTests")} required tests — below the contract threshold.`;
    case "junit_missing":
      return `your test command exited 0 but wrote NO JUnit report to "${requiredOf("reportPath")}" (read reason: ${observedOf("readReason")}). Configure your test runner to emit a JUnit report at that path (e.g. vitest --reporter=junit --outputFile=...).`;
    case "artifact_absent":
      return `your step exited 0 but wrote NO artifact to "${requiredOf("path")}" (read reason: ${observedOf("readReason")}). The step's contract is to produce that artifact — do so.`;
    case "artifact_too_small":
      return `your step's artifact at "${requiredOf("path")}" is ${observedOf("bytes")} bytes — below the ${requiredOf("minBytes")} byte threshold.`;
    case "stdout_count_below_threshold":
      return `your step's stdout matched "${requiredOf("pattern")}" ${observedOf("matches")} times — below the required ${requiredOf("min")} times.`;
    default:
      // Defense-in-depth fallback: the schema marks `reason` optional even on the
      // failure branch, so a malformed event payload could land here. Stringify the
      // reason (or "unknown") so the directive still names something.
      return `evidence insufficient (${stringifyEvidenceValue(ev.reason ?? "unknown")})`;
  }
}

// The captured stdout/stderr tail of the step that failed the gate (apex pre-run §7.4):
// the gate runner already captured up to 4KB of the failing step's combined output in
// `outputTail`. This is the ACTUAL error message (the failing fmt/lint/type/test output,
// e.g. prettier naming the unformatted files + "Run Prettier with --write to fix") and
// is the load-bearing rework context: feeding it to the writer lets it fix the named
// failure directly instead of re-running the gate to rediscover it (the apex-v36
// identical-output non-convergence). Shared by `gateReason` (the fast-tier writer
// steering), `mergeGateRejection` (the merge-tier self-heal), AND `gateFindings` (the
// spec-tier P0 finding), so EVERY gate-rework path feeds the writer the same actionable
// failure content. Stack-agnostic — the project DECLARES its gate steps in `.tanren/
// ci.yml`; this surfaces whatever those steps emitted, never a baked-in tool name.
export function failedStepOutputTail(failure: Extract<GateOutcome, { passed: false }>["failure"]): string {
  const failedStep = failure.steps.find((step) => step.name === failure.failedStep) ?? failure.steps.at(-1);
  return failedStep?.outputTail.trim() ?? "";
}

// Render a hard writer failure (timeout / crash) into rework steering that makes the NEXT
// attempt DIFFERENT, never an identical re-run to an identical failure (the apex-v36
// "writer timed out mid-subtask, identical output" non-convergence). A TIMEOUT means the
// subtask was too large to finish in one writer call — so steer the writer to CHANGE
// APPROACH: commit the partial progress it already made (so the diff grows attempt over
// attempt instead of resetting), then do the SMALLEST next increment rather than
// re-attempting the whole subtask from scratch. A crash gets a plain note (re-run, the
// detector converges a recurring identical crash). Stack-agnostic — no tool/scope hints
// baked in; the writer decides the smaller increment from the subtask intent.
export function writerFailureReason(failureKind: "crashed" | "timeout"): string {
  if (failureKind === "timeout") {
    return (
      "the previous attempt TIMED OUT mid-subtask — the subtask was too large to finish in " +
      "one writer call. CHANGE APPROACH this time: COMMIT the partial progress you already " +
      "made, then do the SMALLEST next increment toward the subtask intent (do NOT restart " +
      "from scratch and do NOT re-attempt the whole subtask at once). Build it up incrementally " +
      "across attempts so each attempt commits real forward progress before it can time out."
    );
  }
  return "the previous attempt CRASHED mid-subtask before finishing — re-attempt it, committing progress as you go.";
}
