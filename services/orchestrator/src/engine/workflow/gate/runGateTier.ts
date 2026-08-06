// in-loop deterministic gate-check stage. This is the automation half
// of the verification split: it runs a CI tier's shell steps over SSH in the
// bootstrapped runner workspace and judges pass/fail PURELY from exit codes.
// There is no Answerer / model here — correctness is exit codes only. The
// fast tier runs after each writer iteration; the slow tier runs before the
// audit. A failing tier short-circuits at the first nonzero step (later steps
// are pointless once the tree is known-broken) and routes the run to rework.
import type { CiStep, CiWhen, RegressionBaseline } from "../../ci/index.js";
import { evidenceForStep } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../../events/index.js";
import { type EvidenceVerdict, harvestStepEvidence } from "./harvestStepEvidence.js";
import {
  type GateStepFailReason,
  type GateStepOutcome,
  type RegressionVerdict,
  type StepExecution,
  combinedOutput,
  tailOf,
} from "./gateStepTypes.js";
// Re-exported so existing consumers keep importing the step vocabulary from the runner.
export type { GateStepFailReason, GateStepOutcome, RegressionVerdict, StepExecution };
export { combinedOutput, tailOf };
import { clearRegressionReport, judgeRegression, regressionExecution, runStepCommand } from "./regressionJudgment.js";
import type { JunitReport } from "../../ci/junit.js";

// A typed pass/fail result for the whole tier. `failedStep` is populated only
// when `passed` is false (the first step that did not exit 0). `failedReason` +
// `evidence` discriminate the v57 evidence-insufficient class on the failure branch.
// `parsedJunitReports` is a SIDE CHANNEL (keyed by step name) of any JUnit XML the
// evidence harvester already read + parsed during this tier — exposed so the
// downstream per-test ingest reuses the parsed report instead of re-reading SSH.
// BACK-COMPAT: `failedReason` is OPTIONAL — synthesized failure callers (bootstrap /
// invalid-ci-config) omit it; the absent default is `"exit_code"`. New runtime gate
// failures populate it; downstream consumers tolerate undefined.
export type GateTierResult =
  | {
      passed: true;
      tier: string;
      when: CiWhen;
      steps: GateStepOutcome[];
      parsedJunitReports?: ReadonlyMap<string, JunitReport>;
    }
  | {
      passed: false;
      tier: string;
      when: CiWhen;
      failedStep: string;
      exitCode: number | null;
      failedReason?: GateStepFailReason;
      evidence?: EvidenceVerdict;
      regression?: RegressionVerdict;
      steps: GateStepOutcome[];
      parsedJunitReports?: ReadonlyMap<string, JunitReport>;
    };

// The event-append seam, identical to the one runSubtaskLoop uses, so the gate
// emits through the same store.
export interface GateAppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

export interface RunGateTierInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  tier: string;
  when: CiWhen;
  steps: ReadonlyArray<CiStep>;
  appendEvent: GateAppendEvent;
  // Correlates the gate.* events with the loop task that triggered them (the
  // writer task for per_iteration, the planner task for pre_audit).
  taskId?: string;
  // LENIENT POSTURE (advisory steps): step NAMES whose failure is ADVISORY — the
  // step still runs and its outcome is recorded (a `gate.advisory_failed` warning
  // event), but it does NOT short-circuit the tier or fail the gate. Empty (the
  // default, every non-lenient posture) ⇒ every step blocks, behavior unchanged.
  advisoryStepNames?: ReadonlySet<string>;
  // FLAKY-QUARANTINE ACTUATION (CI-intelligence): step NAMES on the project's
  // ACTIVE quarantine surface (`quarantined_tests`). A step in this set that fails
  // is EXCLUDED from the verdict (a `gate.quarantine_excluded` warning is emitted,
  // the tier keeps running, the gate stays passing for it) — this is what CLOSES
  // the flaky→quarantine→ship loop. SAFETY: a name lands here ONLY because the
  // detector PROVED the step toggled (passed AND failed) on UNCHANGED code; a
  // consistently-failing step is never quarantined, so a real regression is never
  // masked. Distinct from `advisoryStepNames` (posture-driven, lint/typecheck only)
  // — this is surface-driven and applies under EVERY posture. Empty ⇒ no exclusion.
  quarantinedStepNames?: ReadonlySet<string>;
  // Plane B: the PROJECT's dev+test app env, materialized into the
  // EXECUTED command's environment (the building agent's test/dev commands need
  // it). Prepended ONLY to the command handed to the substrate — the emitted
  // gate.* `step.run` stays the ORIGINAL command, so no secret value reaches the
  // events table. Distinct from Tanren's own provider creds. Undefined ⇒ no env.
  appEnv?: Record<string, string>;
  // THE REGRESSION BASELINE: the set of test ids that PASSED on this run's untouched base
  // tree, captured once at workspace prep before the writer touched anything. A step that
  // declares a `regression` contract is judged against this instead of on absolute
  // redness. ABSENT ⇒ no baseline could be established for this run; a regression step
  // then SKIPS its judgment (see `judgeRegression`) rather than falling back to absolute
  // redness — which would re-import the thrash the contract exists to prevent.
  regressionBaseline?: RegressionBaseline;
}

// Runs every step of one tier in order, stopping at the first failure. Emits
// gate.started before the run and exactly one of gate.passed / gate.failed
// after. Never throws on a step failure — a nonzero exit is a normal gate
// result, returned as { passed: false }. Substrate failures and timeouts also
// count as a failed step (the tree could not be verified).
export async function runGateTier(input: RunGateTierInput): Promise<GateTierResult> {
  await input.appendEvent(
    "gate.started",
    { tier: input.tier, when: input.when, stepNames: input.steps.map((step) => step.name) },
    input.taskId,
  );

  const advisoryStepNames = input.advisoryStepNames ?? EMPTY_ADVISORY_SET;
  const quarantinedStepNames = input.quarantinedStepNames ?? EMPTY_ADVISORY_SET;
  const outcomes: GateStepOutcome[] = [];
  // Side-channel: the harvester's parsed JUnit reports, keyed by step name. Reused by
  // the downstream per-test ingest so it never re-reads the same file over SSH.
  const parsedJunitReports = new Map<string, JunitReport>();
  for (const step of input.steps) {
    const { outcome, exitCode, failReason, evidenceVerdict, regressionVerdict } = await executeStep(
      input,
      step,
      parsedJunitReports,
    );
    outcomes.push(outcome);
    const passed = outcome.passed;
    // LENIENT POSTURE: an advisory step's failure is RECORDED but does NOT block.
    // We emit a `gate.advisory_failed` warning (so the timeline shows the real
    // lint/type issue) and continue running the rest of the tier — the gate stays
    // passing for this step. A genuinely-broken tree still blocks because build /
    // test are never advisory.
    if (!passed && advisoryStepNames.has(step.name)) {
      await input.appendEvent(
        "gate.advisory_failed",
        {
          tier: input.tier,
          when: input.when,
          advisoryStep: step.name,
          exitCode,
          outputTail: outcome.outputTail,
        },
        input.taskId,
      );
      continue;
    }
    // FLAKY-QUARANTINE: a proven-flaky step's failure is RECORDED but does NOT
    // block. We emit `gate.quarantine_excluded` (the timeline shows the excluded
    // flake) and keep running the tier — the gate stays passing for this step, so
    // the merge can go green while a root-cause spec is in flight. This CLOSES the
    // flaky→quarantine→ship loop. A consistently-failing step is never quarantined
    // (the detector only records a proven toggle), so a real regression still blocks.
    if (!passed && quarantinedStepNames.has(step.name)) {
      await input.appendEvent(
        "gate.quarantine_excluded",
        {
          tier: input.tier,
          when: input.when,
          quarantinedStep: step.name,
          exitCode,
          outputTail: outcome.outputTail,
        },
        input.taskId,
      );
      continue;
    }
    if (!passed) {
      const evidencePayload =
        evidenceVerdict !== undefined && !evidenceVerdict.sufficient ? evidenceVerdict : undefined;
      const failed: GateTierResult = {
        passed: false,
        tier: input.tier,
        when: input.when,
        failedStep: step.name,
        exitCode,
        failedReason: failReason,
        ...(evidencePayload === undefined ? {} : { evidence: evidencePayload }),
        ...(regressionVerdict === undefined ? {} : { regression: regressionVerdict }),
        steps: outcomes,
        ...(parsedJunitReports.size === 0 ? {} : { parsedJunitReports }),
      };
      await input.appendEvent(
        "gate.failed",
        {
          tier: input.tier,
          when: input.when,
          failedStep: step.name,
          exitCode,
          steps: outcomes,
          failedReason: failReason,
          ...(regressionVerdict === undefined ? {} : { regression: regressionVerdict }),
          ...(evidencePayload === undefined
            ? {}
            : {
                evidence: {
                  kind: evidencePayload.kind,
                  sufficient: false,
                  reason: evidencePayload.reason,
                  observed: evidencePayload.observed,
                  required: evidencePayload.required,
                },
              }),
        },
        input.taskId,
      );
      return failed;
    }
  }

  await input.appendEvent("gate.passed", { tier: input.tier, when: input.when, steps: outcomes }, input.taskId);
  return {
    passed: true,
    tier: input.tier,
    when: input.when,
    steps: outcomes,
    ...(parsedJunitReports.size === 0 ? {} : { parsedJunitReports }),
  };
}

// Shared empty advisory set so the strict (default) path allocates nothing.
const EMPTY_ADVISORY_SET: ReadonlySet<string> = new Set<string>();

// Execute ONE step end-to-end: run the SSH command, harvest declared evidence on an
// exit-0, and build the outcome + fail-reason discriminator. Extracted from runGateTier
// to keep the orchestration loop under the architecture's cyclomatic-complexity cap.
//
// EVIDENCE GATE (apex v57 task #64): when the step declared an evidence contract (or
// its legacy `junitReport` promoted to one) AND the process exited 0, harvest POSITIVE
// proof BEFORE judging the step a pass. An exit-0 with insufficient evidence is the
// v57 green-by-accident class — the writer produced no real work but the process
// exited 0 (an empty `files` tsc, a vitest with zero tests, a playwright with no
// browsers). A nonzero exit is already a failure — no need to harvest. The QUARANTINE
// + ADVISORY bypasses (in the caller) are for known-broken/known-flaky steps; they do
// NOT skip evidence checks (a vacuous-success step is a different class).
async function executeStep(
  input: RunGateTierInput,
  step: CiStep,
  parsedJunitReports: Map<string, JunitReport>,
): Promise<StepExecution> {
  // REGRESSION FRESHNESS — clear a stale report BEFORE the run, sharing the confirmation
  // retry's clear-before-run invariant. The baseline capture (and every prior iteration)
  // wrote a JUnit report to this same reportPath in this persistent workspace, so a first
  // run that completes without regenerating the report would let judgeRegression read that
  // stale (all-green) baseline and pass — the identical fail-open the retry path guards
  // against. A clear that cannot be confirmed forces `unreadable` (fail-closed) below.
  const reportCleared =
    step.regression === undefined ? true : await clearRegressionReport(input, step.regression.reportPath);
  const result = await runStepCommand(input, step);
  const exitOk = result.failure === undefined && result.stalled !== true && result.exitCode === 0;
  // REGRESSION CONTRACT — evaluated BEFORE the evidence/exit judgment, because it
  // REPLACES that judgment for this step. A test step whose suite is red exits nonzero,
  // and the whole point of the contract is that a nonzero exit is no longer automatically
  // fatal: the step is judged on whether anything GREEN went RED, not on absolute
  // redness. A substrate failure or a watchdog stall is NOT a test result, so those keep
  // their ordinary fatal meaning and never reach the comparison.
  const substrateOk = result.failure === undefined && result.stalled !== true;
  if (step.regression !== undefined && substrateOk) {
    // A failed pre-run clear cannot be trusted: the report the judgment would read may be
    // the stale baseline, so treat it as unreadable rather than judging on a report the
    // run may not have produced.
    const judgment = reportCleared
      ? await judgeRegression(input, step, step.regression.reportPath, parsedJunitReports)
      : ({ kind: "unreadable" } as const);
    if (judgment.kind !== "skip") {
      return regressionExecution(step, result, judgment);
    }
  }
  const evidenceContract = evidenceForStep(step);
  let evidenceVerdict: EvidenceVerdict | undefined;
  if (exitOk && evidenceContract !== undefined) {
    const harvest = await harvestStepEvidence(
      { ssh: input.ssh, target: input.target, workspacePath: input.workspacePath },
      evidenceContract,
      result.stdout,
    );
    evidenceVerdict = harvest.verdict;
    if (harvest.parsedJunitReport !== undefined) {
      parsedJunitReports.set(step.name, harvest.parsedJunitReport);
    }
  }
  const evidenceOk = evidenceVerdict === undefined || evidenceVerdict.sufficient;
  const passed = exitOk && evidenceOk;
  const outcome: GateStepOutcome = {
    name: step.name,
    run: step.run,
    exitCode: result.exitCode,
    passed,
    // The gate-step domain field records "did not complete"; sourced from the
    // progress-based no-life flag (`stalled`).
    timedOut: result.stalled === true,
    outputTail: tailOf(combinedOutput(result)),
    ...(evidenceVerdict === undefined ? {} : { evidence: evidenceVerdict }),
  };
  // exit_code = the process exited nonzero / timed out / substrate failed (historical);
  // evidence_insufficient = exit was 0 but the declared positive proof was missing
  // (the green-by-accident class). The writer rework directive steers off this.
  const failReason: GateStepFailReason = exitOk && !evidenceOk ? "evidence_insufficient" : "exit_code";
  return { outcome, exitCode: result.exitCode, failReason, evidenceVerdict, regressionVerdict: undefined };
}
