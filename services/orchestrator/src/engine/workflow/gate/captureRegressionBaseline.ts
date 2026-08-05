// BASELINE CAPTURE — the once-per-run measurement that makes the regression contract
// meaningful (engine/ci/regression.ts).
//
// The contract needs to know which tests were GREEN BEFORE THE WRITER TOUCHED ANYTHING.
// This module produces that, by running the project's own declared regression step
// against the untouched base tree at workspace prep — after bootstrap (so dependencies
// exist) and before the first writer call (so the tree is exactly the run's base).
//
// WHY NOT READ IT FROM THE PER-TEST HISTORY. Tanren already persists per-test rows
// (`ci_test_results`, keyed by head sha) from every gate that declares a `junitReport`,
// and reading the baseline from the row set at the run's base sha would cost nothing.
// It was rejected: the base a run clones is the TARGET BRANCH TIP, and the previous
// spec's `pre_merge` gate ingested its grain against the PR HEAD sha — which is not the
// sha that lands once the forge squashes or merges. So the lookup misses for exactly the
// common case, and a baseline that is usually absent is worse than no feature at all: it
// would make the regression judgment silently skip on most runs, which is the failure
// mode hardest to notice. Measuring it directly is one suite run and is always correct.
//
// WHY IT IS SAFE TO SPEND A SUITE RUN. It is spent ONLY by a project that declared a
// `regression` step — absence is the opt-out, and it costs nothing to decline. For a
// project that opts in, the same suite is about to run on every writer iteration anyway,
// so the marginal cost is one additional run per SPEC, not per iteration.
//
// FAIL-OPEN, LOUDLY. Every failure here yields `undefined` (no baseline) plus a durable
// event, and the run proceeds. That is the correct direction and it masks nothing: with
// no baseline the per-iteration regression judgment SKIPS, which leaves the loop exactly
// as it behaves today — tests first judged at `pre_audit`, absolutely, and the merge
// authority at `pre_merge` untouched. Bricking a run because an early-warning measurement
// failed would trade a real capability for a worse one.

import type { CiConfigV1 } from "../../ci/index.js";
import { type RegressionBaseline, baselineFromReport, regressionStepFor } from "../../ci/index.js";
import { parseJunitReport } from "../../ci/junit.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { buildActivityWatchdog } from "../../ssh/activityWatchdog.js";
import { withAppEnv } from "../../ssh/appEnvPrelude.js";
import { withMiseActivation } from "../../ssh/miseActivate.js";
import { createLogger } from "../../observability/logger.js";
import { readWorkspaceFile } from "./harvestStepEvidence.js";

const log = createLogger("gate");

// Why a baseline could not be established. Each maps to a distinct operator diagnosis;
// none of them blocks the run.
//   - step_failed        the substrate could not run the command at all (transport / stall)
//   - report_missing     the command ran but wrote no readable report at the declared path
//   - report_unparseable a report exists but is not JUnit we can read
//   - no_passing_tests   parsed cleanly, but nothing passed — nothing can regress from it
export type BaselineFailure = "step_failed" | "report_missing" | "report_unparseable" | "no_passing_tests";

export type CaptureBaselineResult =
  | { kind: "captured"; baseline: RegressionBaseline }
  | { kind: "not_declared" }
  | { kind: "failed"; reason: BaselineFailure };

export interface CaptureRegressionBaselineInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  config: CiConfigV1;
  /** The project's dev+test app env, so the baseline command runs exactly as the gate's
   *  will. Never logged or emitted. */
  appEnv?: Record<string, string>;
}

/**
 * Capture the run's regression baseline, if the project declared one.
 *
 * The declared step is looked up at `per_iteration` — the only lifecycle point the
 * contract is meant for, and the one whose tier will be judged against this baseline.
 * A project that declares no regression step returns `not_declared` without running
 * anything, which is the zero-cost opt-out.
 *
 * NOTE ON THE STEP'S EXIT CODE: it is deliberately IGNORED. The base tree may legitimately
 * have failing tests — the repository this was designed against has three — and refusing
 * to build a baseline because the base is not perfectly green would disable the contract
 * on exactly the codebases that need it most. What matters is the REPORT: whatever passed
 * here is what the writer is not allowed to break.
 */
export async function captureRegressionBaseline(input: CaptureRegressionBaselineInput): Promise<CaptureBaselineResult> {
  const declared = regressionStepFor(input.config, "per_iteration");
  if (declared === undefined) return { kind: "not_declared" };
  const { step, reportPath } = declared;
  const result = await input.ssh.run(input.target, {
    command: withMiseActivation(withAppEnv(step.run, input.appEnv)),
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
  });
  if (result.failure !== undefined || result.stalled === true) {
    log.error("regression baseline: the declared step could not be run (no baseline for this run)", {
      step: step.name,
      tier: declared.tier,
      stalled: result.stalled === true,
    });
    return { kind: "failed", reason: "step_failed" };
  }
  const read = await readWorkspaceFile(
    { ssh: input.ssh, target: input.target, workspacePath: input.workspacePath },
    reportPath,
  );
  if (!read.present) {
    log.error("regression baseline: the declared step wrote no readable JUnit report", {
      step: step.name,
      reportPath,
      readReason: read.reason,
    });
    return { kind: "failed", reason: "report_missing" };
  }
  let baseline: RegressionBaseline;
  try {
    baseline = baselineFromReport(parseJunitReport(read.contents));
  } catch (error) {
    log.error("regression baseline: the JUnit report could not be parsed", { step: step.name, reportPath }, error);
    return { kind: "failed", reason: "report_unparseable" };
  }
  if (baseline.passing.size === 0) {
    // A baseline with nothing green cannot detect a regression — every comparison against
    // it is vacuously clean. Reporting that as a captured baseline would look like the
    // contract is protecting the run when it provably is not. This is the greenfield
    // scaffold case (no tests yet) and the broken-fixture-root case, and both should read as
    // "no baseline" rather than "baseline of zero".
    log.error("regression baseline: the report parsed but contained no passing tests (no baseline for this run)", {
      step: step.name,
      reportPath,
      total: baseline.total,
    });
    return { kind: "failed", reason: "no_passing_tests" };
  }
  return { kind: "captured", baseline };
}
