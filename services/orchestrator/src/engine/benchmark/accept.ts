// Post-merge ACCEPT step (docs/roadmap/tanren-method-benchmark.md §2.1, §2.3).
//
// The hidden acceptance tier. After a benchmark trial's PR merges, this runs the
// cell's frozen `accept` tier — the equivalence oracle the config under test
// never saw or edited — against the merged result, over the SAME SSH/runner
// substrate the in-loop gate uses (`runGateTier` semantics: exit-code driven, no
// agent). It emits exactly one of the net-new `benchmark.accept.passed` /
// `benchmark.accept.failed` events and returns the AcceptResult that populates
// `reachedAcceptGreen` on the TrialScorecard + `experiment_trials.accept_result`.
//
// This is the benchmark analogue of `engine/workflow/gate/runGateTier.ts`: it
// reuses the same SshSubstrate + the same bounded-output-tail discipline, but
// keys off the benchmark identities (cell + trial + content-addressed accept-tier
// hash) rather than the run's loop task, and is run POST-merge rather than
// in-loop. An un-runnable accept tier (no steps, or a substrate failure with no
// step to attribute) is a FAILED accept, never a silent pass — the oracle must
// actually run green to count.

import type { CiStep } from "../ci/index.js";
import type { SshTarget } from "../contracts/allocator.js";
import type { SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { AcceptResult } from "./entities.js";
import type { BenchmarkAcceptStepResult } from "../events/schemas/benchmark.js";

// Matches the gate runner's tail bound so accept output stays small in events.
const OUTPUT_TAIL_LIMIT = 4_000;

// The event-append seam, identical to the gate's, so the accept step emits
// through the same typed PgEventStore.
export interface AcceptAppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

export interface RunAcceptStepInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  /** The hidden accept tier's resolved steps (from the cell's frozen config). */
  steps: ReadonlyArray<CiStep>;
  /** The content-addressed accept-tier hash (§3.1) — the oracle's fingerprint. */
  acceptTierHash: string;
  cellId: string;
  trialIndex: number;
  /** The tier name (defaults to `accept`); carried verbatim onto the events. */
  tier?: string;
  timeoutMs: number;
  appendEvent: AcceptAppendEvent;
  /** Correlates the accept events with the trial's run task, when known. */
  taskId?: string;
}

export interface AcceptStepOutcome {
  result: AcceptResult;
  steps: BenchmarkAcceptStepResult[];
}

/**
 * Run the hidden accept tier against the merged result and emit the verdict
 * event. Runs every step in order, stopping at the first failure (a known-broken
 * tree fails no matter what later steps do). Emits `benchmark.accept.passed` when
 * every step exits 0, else `benchmark.accept.failed`. Never throws on a step
 * failure — a nonzero exit / timeout / substrate error is a normal FAILED accept.
 * An EMPTY accept tier is a failed accept (no oracle ⇒ no green), never a vacuous
 * pass, so a misconfigured cell can never silently score every trial green.
 */
export async function runAcceptStep(input: RunAcceptStepInput): Promise<AcceptStepOutcome> {
  const tier = input.tier ?? "accept";

  if (input.steps.length === 0) {
    await input.appendEvent(
      "benchmark.accept.failed",
      {
        cellId: input.cellId,
        trialIndex: input.trialIndex,
        tier,
        acceptTierHash: input.acceptTierHash,
        failedStep: null,
        exitCode: null,
        reason: "accept tier has no steps; an un-evaluable oracle is a failed accept",
        steps: [],
      },
      input.taskId,
    );
    return { result: "failed", steps: [] };
  }

  const steps: BenchmarkAcceptStepResult[] = [];
  for (const step of input.steps) {
    const result = await input.ssh.run(input.target, {
      command: step.run,
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
    });
    const passed = result.failure === undefined && !result.timedOut && result.exitCode === 0;
    steps.push({
      name: step.name,
      run: step.run,
      exitCode: result.exitCode,
      passed,
      timedOut: result.timedOut,
      outputTail: tailOf(combinedOutput(result)),
    });
    if (!passed) {
      await input.appendEvent(
        "benchmark.accept.failed",
        {
          cellId: input.cellId,
          trialIndex: input.trialIndex,
          tier,
          acceptTierHash: input.acceptTierHash,
          failedStep: step.name,
          exitCode: result.exitCode,
          reason: null,
          steps,
        },
        input.taskId,
      );
      return { result: "failed", steps };
    }
  }

  await input.appendEvent(
    "benchmark.accept.passed",
    {
      cellId: input.cellId,
      trialIndex: input.trialIndex,
      tier,
      acceptTierHash: input.acceptTierHash,
      steps,
    },
    input.taskId,
  );
  return { result: "passed", steps };
}

function combinedOutput(result: SshCommandResult): string {
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
