// THE REGRESSION JUDGMENT — the gate-side half of the regression contract
// (engine/ci/regression.ts holds the pure comparison and the argument for it).
//
// Split out of runGateTier.ts so both modules stay under the 500-line architecture cap.
// This module owns everything that happens when a step declares `regression`: running the
// step, reading and comparing its JUnit report, the confirmation re-run that keeps a flake
// from steering the writer, and the writer-facing directive the failure renders into.

import type { CiStep, RegressionBaseline } from "../../ci/index.js";
import { confirmRegressions, describeRegressions, detectRegressions, sampleRegressions } from "../../ci/index.js";
import { type JunitReport, parseJunitReport } from "../../ci/junit.js";
import type { CommandResult, CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import { readWorkspaceFile } from "./harvestStepEvidence.js";
import {
  type GateStepFailReason,
  type RegressionVerdict,
  type StepExecution,
  combinedOutput,
  tailOf,
} from "./gateStepTypes.js";
import { withAppEnv } from "../../ssh/appEnvPrelude.js";
import { withMiseActivation } from "../../ssh/miseActivate.js";
import { buildActivityWatchdog, outputOnlyWatchdog } from "../../ssh/activityWatchdog.js";
import { quoteSshShellArg } from "../../ssh/command.js";

export interface RegressionStepDeps {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  appEnv?: Record<string, string>;
  regressionBaseline?: RegressionBaseline;
}

export async function runStepCommand(input: RegressionStepDeps, step: CiStep): Promise<CommandResult> {
  return await input.ssh.run(input.target, {
    // PROJECT-COMMAND path: mise-activate so a bare `node`/`pnpm`/etc in the project's
    // gate command resolves to its `mise.toml`-declared toolchain (a no-op when the
    // project declared none), THEN prepend the app-env prelude. Both are prepended to
    // the EXECUTED command only; the emitted `step.run` stays the original (no secret,
    // no prelude in events). PROJECT path — codex/answerers never run through here.
    command: withMiseActivation(withAppEnv(step.run, input.appEnv)),
    cwd: input.workspacePath,
    // VCS/build op (the project's gate step): output-driven + the workspace as the
    // silent-stretch liveness probe. NEVER killed for elapsed time — a long test suite
    // that keeps producing output/touching files runs unbounded.
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
  });
}

/**
 * Delete a workspace-relative file over SSH, returning whether the removal is known to have
 * succeeded. Used to clear the previous JUnit report before the confirmation re-run so a
 * stale report can never be mistaken for fresh results. A substrate failure returns false
 * (the caller fails the step) rather than proceeding with a report it cannot trust.
 *
 * CONTAINMENT, restated here on purpose. This is the only DESTRUCTIVE operation the gate
 * performs on a path the PROJECT declares, and `.tanren/ci.yml` is writer-editable. The
 * schema already refuses absolute paths and `..` segments, but a second gate on the
 * operation itself is cheap and the failure mode it prevents (deleting runner state outside
 * the workspace) is not recoverable. Refusing is safe: the caller treats it as "could not
 * clear" and fails the step.
 */
function isContainedRelPath(relPath: string): boolean {
  return relPath !== "" && !relPath.startsWith("/") && !relPath.includes("\\") && !relPath.split("/").includes("..");
}

async function removeWorkspaceFile(input: RegressionStepDeps, relPath: string): Promise<boolean> {
  if (!isContainedRelPath(relPath)) return false;
  const path = `${input.workspacePath.replace(/\/+$/u, "")}/${relPath}`;
  const result = await input.ssh.run(input.target, {
    command: `rm -f ${quoteSshShellArg(path)}`,
    watchdog: outputOnlyWatchdog(),
  });
  return result.failure === undefined && result.stalled !== true && result.exitCode === 0;
}

/** The regression judgment's outcome. `skip` leaves the step to the ordinary exit-code +
 *  evidence path; `verdict` replaces it. */
type RegressionJudgment = { kind: "skip" } | { kind: "unreadable" } | { kind: "verdict"; verdict: RegressionVerdict };

/**
 * Judge a step that declared a `regression` contract: read its JUnit report, compare
 * against the run's baseline, and — only when something appears to have regressed —
 * re-run the step once and intersect, so a flake cannot steer the writer.
 *
 * NO BASELINE ⇒ `skip`, and the step falls back to its ordinary judgment. This is the
 * honest direction and it cannot mask anything: the per-iteration regression judgment is
 * an EARLY-WARNING that duplicates no authority. `pre_audit` and `pre_merge` still run
 * their own unscoped, absolute test steps, so skipping here delays the signal to exactly
 * where it lives today — it can never let a regression merge.
 *
 * AN UNREADABLE REPORT IS A FAILURE, never a pass. A step whose suite is red exits
 * nonzero, and this contract's whole job is to stop treating that exit as fatal — which
 * means a nonzero exit caused by something OTHER than test failures (a collection error,
 * a crashed runner, an OOM) must still fail, and the only way to tell the two apart is
 * that the first produces a parseable report and the second does not.
 */
export async function judgeRegression(
  input: RegressionStepDeps,
  step: CiStep,
  reportPath: string,
  parsedJunitReports: Map<string, JunitReport>,
): Promise<RegressionJudgment> {
  const baseline = input.regressionBaseline;
  if (baseline === undefined) return { kind: "skip" };
  const deps = { ssh: input.ssh, target: input.target, workspacePath: input.workspacePath };
  const read = await readWorkspaceFile(deps, reportPath);
  if (!read.present) return { kind: "unreadable" };
  let report: JunitReport;
  try {
    report = parseJunitReport(read.contents);
  } catch {
    return { kind: "unreadable" };
  }
  parsedJunitReports.set(step.name, report);
  const firstPass = detectRegressions(baseline, report);
  if (firstPass.length === 0) {
    return {
      kind: "verdict",
      verdict: {
        regressed: [],
        regressedCount: 0,
        unconfirmedCount: 0,
        baselineTotal: baseline.total,
        observedTotal: report.total,
      },
    };
  }
  // CONFIRMATION RE-RUN — the failure path only. The suite this contract was designed
  // against measures a ~25% per-run flake rate from a repo-wide per-test wall-clock
  // budget, so a single red report is not evidence of breakage. Re-run and intersect: a
  // test that regresses TWICE is real; one that passes on the retry was contention.
  // DELETE THE FIRST RUN'S REPORT FIRST. Without this, a confirmation run that dies before
  // writing (a crash, an OOM, a stall) leaves the ORIGINAL report in place — we would re-read
  // the first run's failures, "confirm" them against themselves, and report a flake as a real
  // regression. That is precisely the false positive the confirmation run exists to prevent,
  // so the read must be unable to succeed unless the retry actually produced fresh results.
  if (!(await removeWorkspaceFile(input, reportPath))) return { kind: "unreadable" };
  // The confirmation run's EXIT CODE is deliberately ignored, exactly as the first run's is:
  // a red suite exits nonzero either way, and the verdict comes from the report.
  await runStepCommand(input, step);
  const confirmRead = await readWorkspaceFile(deps, reportPath);
  if (!confirmRead.present) return { kind: "unreadable" };
  let confirmReport: JunitReport;
  try {
    confirmReport = parseJunitReport(confirmRead.contents);
  } catch {
    return { kind: "unreadable" };
  }
  // The confirmation run's report is the one we keep for the per-test ingest: it is the
  // most recent observation of the tree, and it is the one the verdict was decided on.
  parsedJunitReports.set(step.name, confirmReport);
  const secondPass = detectRegressions(baseline, confirmReport);
  const confirmed = confirmRegressions(firstPass, secondPass);
  return {
    kind: "verdict",
    verdict: {
      regressed: sampleRegressions(confirmed),
      regressedCount: confirmed.length,
      unconfirmedCount: firstPass.length - confirmed.length,
      baselineTotal: baseline.total,
      observedTotal: confirmReport.total,
    },
  };
}

/**
 * Build the step execution for a step judged by its `regression` contract. The step
 * PASSES when nothing that was green went red — regardless of its exit code, which is the
 * entire point — and FAILS either on a confirmed regression or on a report the gate could
 * not read (the collection-error / crashed-runner class, which must never be mistaken for
 * "the suite is merely red").
 */
export function regressionExecution(
  step: CiStep,
  result: CommandResult,
  judgment: Extract<RegressionJudgment, { kind: "unreadable" } | { kind: "verdict" }>,
): StepExecution {
  const base = {
    name: step.name,
    run: step.run,
    exitCode: result.exitCode,
    // Always false by construction: the caller only enters the regression path when the
    // substrate neither failed nor stalled (a stall is not a test result).
    timedOut: false,
    outputTail: tailOf(combinedOutput(result)),
  };
  if (judgment.kind !== "verdict" && judgment.kind !== "unreadable") {
    const exhaustive: never = judgment;
    throw new Error(`unhandled regression judgment: ${JSON.stringify(exhaustive)}`);
  }
  if (judgment.kind === "unreadable") {
    // No parseable report ⇒ we cannot tell "red suite" from "the runner never produced
    // results". Fail on the exit-code class, carrying the step's own output so the writer
    // sees the collection error / crash rather than a regression list it cannot act on.
    return {
      outcome: { ...base, passed: false },
      exitCode: result.exitCode,
      failReason: "exit_code",
      evidenceVerdict: undefined,
      regressionVerdict: undefined,
    };
  }
  const { verdict } = judgment;
  const passed = verdict.regressedCount === 0;
  return {
    outcome: { ...base, passed, regression: verdict },
    exitCode: result.exitCode,
    failReason: passed ? "exit_code" : "test_regression",
    evidenceVerdict: undefined,
    regressionVerdict: verdict,
  };
}

// The writer-steering block for a CONFIRMED test regression. Returns undefined for every
// other failure class.
//
// This directive is the entire point of the regression contract, and its value is in WHERE
// it lands: the same writer context that made the edit, one iteration later, naming the
// specific tests that were green before the change. Without the contract that breakage
// surfaces a round later as a `pre_audit` verdict — after the context is gone — and the
// writer remediates blind against failures it has no memory of causing.
export function testRegressionDirective(failure: {
  failedReason?: GateStepFailReason;
  regression?: RegressionVerdict;
}): string | undefined {
  if (failure.failedReason !== "test_regression") return undefined;
  const regression = failure.regression;
  if (regression === undefined || regression.regressedCount === 0) return undefined;
  return describeRegressions(regression.regressed, regression.regressedCount, regression.baselineTotal);
}
