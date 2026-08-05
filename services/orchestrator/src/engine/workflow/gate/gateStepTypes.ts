// SHARED GATE-STEP VOCABULARY — the per-step outcome types and output helpers that both
// the tier runner (runGateTier) and the regression judgment (regressionJudgment) speak.
//
// Extracted into its own module for one concrete reason: the tier runner DELEGATES to the
// regression judgment, and the judgment must produce the runner's own step-outcome shape.
// Left in either file that is an import cycle. Neither owns these types more than the
// other, so they live here and both depend on this.

import type { CommandResult } from "../../contracts/commandSubstrate.js";
import type { EvidenceVerdict } from "./harvestStepEvidence.js";

// Captured command output can be large; we keep only the last N characters so
// the emitted gate.* events and the typed result carry a useful, bounded
// diagnostic without bloating the events table. Matches the bootstrap step's
// tail bound for consistency.
const OUTPUT_TAIL_LIMIT = 4_000;

// The REGRESSION judgment for a step that declared a `regression` contract. Carried on
// BOTH pass and fail: on a pass it records that the comparison ran and found nothing
// (so a green timeline still proves the judgment happened, rather than being silently
// skipped), and on a fail it names the tests the writer's steering must list.
export interface RegressionVerdict {
  /** CONFIRMED pass→fail transitions, bounded to a reportable sample. Empty ⇒ step passes
   *  (check `regressedCount`, not this array's length, for the true verdict). */
  regressed: string[];
  /** TRUE number of confirmed regressions. Zero ⇒ the step passes. */
  regressedCount: number;
  /** Pass→fail transitions the confirmation run cleared as flakes. Never blocks; recorded
   *  so a suite that is quietly burning iterations on contention is visible. */
  unconfirmedCount: number;
  /** Cases in the baseline report (the untouched base tree). */
  baselineTotal: number;
  /** Cases in this step's report. */
  observedTotal: number;
}

/** Run one gate step's shell command over SSH. Shared by the first execution and the
 *  regression contract's confirmation re-run, so both run byte-identically. */
// One executed step's outcome, mirroring the gate.* event shape. `evidence` is the
// optional positive-proof verdict the gate harvested when the step declared an
// evidence contract. Carried on BOTH pass and fail so the
// timeline records observed-vs-required counts even on a pass (visibility), and so a
// fail names the diagnosis precisely (the writer's iteration-1 directive).
export interface GateStepOutcome {
  name: string;
  run: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  outputTail: string;
  evidence?: EvidenceVerdict;
  regression?: RegressionVerdict;
}

// Why a step failed. `exit_code` is the historical case (process exited nonzero / timed
// out / substrate failed) — default for back-compat consumers. `evidence_insufficient` is
// the v57 green-by-accident class: exit was 0 but the declared evidence was
// missing/zero-tests/below-threshold. `test_regression` is the pass→fail transition class:
// a test that was GREEN on the run's base tree is now red, confirmed across two runs. The
// discriminator lets the writer's rework directive steer precisely instead of guessing
// "the gate failed".
export type GateStepFailReason = "exit_code" | "evidence_insufficient" | "test_regression";

export interface StepExecution {
  outcome: GateStepOutcome;
  exitCode: number | null;
  failReason: GateStepFailReason;
  evidenceVerdict: EvidenceVerdict | undefined;
  regressionVerdict: RegressionVerdict | undefined;
}

export function combinedOutput(result: CommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return [result.stdout, result.stderr, detail].filter((part) => part !== undefined && part !== "").join("\n");
  }
  return [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
}

export function tailOf(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}
