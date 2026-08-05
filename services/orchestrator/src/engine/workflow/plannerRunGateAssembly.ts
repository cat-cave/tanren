// ASSEMBLING THE RUN'S GATE — the run loop's gate closure, the merge-gate context, and the
// REGRESSION BASELINE that feeds them.
//
// Split out of plannerRunGate.ts so both stay under the 500-line architecture cap, and
// because these three things share one constraint that nothing else in the run loop does:
// they must be built at the single moment when the workspace is bootstrapped but the writer
// has not run. The baseline is only meaningful measured on the untouched base tree.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { EventStore } from "../eventStore.js";
import type { RegressionBaseline } from "../ci/index.js";
import { captureRegressionBaseline, resolveGateConfig } from "./gate/index.js";
import { createLogger } from "../observability/logger.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import type { MergeGateRunContext } from "./plannerRunCi.js";
import { type RunGateCallback, buildDefaultGate } from "./plannerRunGate.js";

const log = createLogger("gate");

/**
 * Assemble the run's GATE: the deterministic gate closure plus the merge-gate context the
 * publish / re-gate stages take, with the regression baseline measured first.
 *
 * A caller-injected `input.runGate` (the unit/test seam) wins and skips the baseline
 * entirely — a scripted gate has nothing to compare against, and `??` short-circuits so
 * the measurement is never even attempted.
 */
export async function buildRunGate(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  eventStore: EventStore,
): Promise<{ runGate: RunGateCallback; mergeGateCtx: MergeGateRunContext }> {
  const runGate =
    input.runGate ??
    buildDefaultGate(
      input,
      target,
      workspacePath,
      eventStore,
      await resolveRunRegressionBaseline(input, target, workspacePath),
    );
  return { runGate, mergeGateCtx: { runGate, target, workspacePath, eventStore } };
}

/**
 * Measure the run's REGRESSION BASELINE once, at workspace prep, on the untouched base
 * tree — the set of tests that were green BEFORE the writer touched anything. This is what
 * lets the per-iteration gate include tests without thrashing: a failure is judged as a
 * pass->fail TRANSITION against this set, so a writer mid-feature is never blocked on
 * tests it is still authoring, while a pre-existing test it BROKE stops the iteration
 * immediately, in the context that broke it.
 *
 * ZERO-COST OPT-OUT: a project whose `.tanren/ci.yml` declares no `regression` step
 * short-circuits inside `captureRegressionBaseline` before running anything. Nothing is
 * spent, and nothing about its gate changes.
 *
 * TOTALLY NON-FATAL. Every failure path — an unreadable/invalid ci.yml, a substrate fault,
 * a step that will not run, an unparseable report — yields `undefined` and the run
 * proceeds. This is a deliberate fail-OPEN and it masks nothing: with no baseline the
 * per-iteration regression judgment SKIPS, which leaves the loop behaving exactly as it
 * does today (tests judged absolutely at `pre_audit`, merge authority untouched at
 * `pre_merge`). Bricking a run because an early-warning measurement failed would trade a
 * real capability for a strictly worse one.
 */
export async function resolveRunRegressionBaseline(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
): Promise<RegressionBaseline | undefined> {
  try {
    const config = await resolveGateConfig({ ssh: input.ssh, target, workspacePath });
    const result = await captureRegressionBaseline({
      ssh: input.ssh,
      target,
      workspacePath,
      config,
      ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
    });
    if (result.kind === "captured") {
      log.info("regression baseline captured for the run", {
        runId: input.context.runId,
        passing: result.baseline.passing.size,
        total: result.baseline.total,
      });
      return result.baseline;
    }
    if (result.kind === "failed") {
      log.error(
        "regression baseline NOT captured — the per-iteration regression judgment will skip for this run " +
          "(tests are still judged absolutely at pre_audit and pre_merge)",
        { runId: input.context.runId, reason: result.reason },
      );
    }
    return undefined;
  } catch (error) {
    log.error(
      "regression baseline capture threw — the per-iteration regression judgment will skip for this run",
      { runId: input.context.runId },
      error,
    );
    return undefined;
  }
}
