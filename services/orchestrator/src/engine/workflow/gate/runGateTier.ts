// P3-0005 in-loop deterministic gate-check stage. This is the automation half
// of the verification split: it runs a CI tier's shell steps over SSH in the
// bootstrapped runner workspace and judges pass/fail PURELY from exit codes.
// There is no Answerer / model here — correctness is exit codes only. The
// fast tier runs after each writer iteration; the slow tier runs before the
// audit. A failing tier short-circuits at the first nonzero step (later steps
// are pointless once the tree is known-broken) and routes the run to rework.
import type { CiStep, CiWhen } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../../events/index.js";
import { withAppEnv } from "../../ssh/appEnvPrelude.js";

// Captured command output can be large; we keep only the last N characters so
// the emitted gate.* events and the typed result carry a useful, bounded
// diagnostic without bloating the events table. Matches the bootstrap step's
// tail bound for consistency.
const OUTPUT_TAIL_LIMIT = 4_000;

// One executed step's outcome, mirroring the gate.* event shape.
export interface GateStepOutcome {
  name: string;
  run: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  outputTail: string;
}

// A typed pass/fail result for the whole tier. `failedStep` is populated only
// when `passed` is false (the first step that did not exit 0).
export type GateTierResult =
  | { passed: true; tier: string; when: CiWhen; steps: GateStepOutcome[] }
  | {
      passed: false;
      tier: string;
      when: CiWhen;
      failedStep: string;
      exitCode: number | null;
      steps: GateStepOutcome[];
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
  timeoutMs: number;
  appendEvent: GateAppendEvent;
  // Correlates the gate.* events with the loop task that triggered them (the
  // writer task for per_iteration, the planner task for pre_audit).
  taskId?: string;
  // LENIENT POSTURE (advisory steps): step NAMES whose failure is ADVISORY — the
  // step still runs and its outcome is recorded (a `gate.advisory_failed` warning
  // event), but it does NOT short-circuit the tier or fail the gate. Empty (the
  // default, every non-lenient posture) ⇒ every step blocks, behavior unchanged.
  advisoryStepNames?: ReadonlySet<string>;
  // Plane B (P-APP-ENV-0): the PROJECT's dev+test app env, materialized into the
  // EXECUTED command's environment (the building agent's test/dev commands need
  // it). Prepended ONLY to the command handed to the substrate — the emitted
  // gate.* `step.run` stays the ORIGINAL command, so no secret value reaches the
  // events table. Distinct from Tanren's own provider creds. Undefined ⇒ no env.
  appEnv?: Record<string, string>;
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
  const outcomes: GateStepOutcome[] = [];
  for (const step of input.steps) {
    const result = await input.ssh.run(input.target, {
      // The app-env prelude is prepended to the EXECUTED command only; the
      // emitted `step.run` below stays the original (no secret in events).
      command: withAppEnv(step.run, input.appEnv),
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
    });
    const passed = result.failure === undefined && !result.timedOut && result.exitCode === 0;
    const outcome: GateStepOutcome = {
      name: step.name,
      run: step.run,
      exitCode: result.exitCode,
      passed,
      timedOut: result.timedOut,
      outputTail: tailOf(combinedOutput(result)),
    };
    outcomes.push(outcome);
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
          exitCode: result.exitCode,
          outputTail: outcome.outputTail,
        },
        input.taskId,
      );
      continue;
    }
    if (!passed) {
      const failed: GateTierResult = {
        passed: false,
        tier: input.tier,
        when: input.when,
        failedStep: step.name,
        exitCode: result.exitCode,
        steps: outcomes,
      };
      await input.appendEvent(
        "gate.failed",
        {
          tier: input.tier,
          when: input.when,
          failedStep: step.name,
          exitCode: result.exitCode,
          steps: outcomes,
        },
        input.taskId,
      );
      return failed;
    }
  }

  await input.appendEvent("gate.passed", { tier: input.tier, when: input.when, steps: outcomes }, input.taskId);
  return { passed: true, tier: input.tier, when: input.when, steps: outcomes };
}

// Shared empty advisory set so the strict (default) path allocates nothing.
const EMPTY_ADVISORY_SET: ReadonlySet<string> = new Set<string>();

function combinedOutput(result: CommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return [result.stdout, result.stderr, detail].filter((part) => part !== undefined && part !== "").join("\n");
  }
  return [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
}

function tailOf(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}
