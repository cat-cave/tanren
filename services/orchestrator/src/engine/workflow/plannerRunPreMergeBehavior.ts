// rv-premerge — the OPT-IN pre-merge BEHAVIOR gate, split out of plannerRunCi.ts to keep
// that file under the 500-line architecture cap. When the project opted into
// `preMergeBehaviorGate` (its producer is then wired) the merge-authority stage deploys the
// PR head to an ephemeral preview, runs rv-11 acceptance against it for the run's declared
// behaviors, records a `purpose='pre_merge'` blocking verdict, and tears the preview down —
// feeding the land-time `resolveLandTimeBehaviorGate`. Default OFF is a genuine zero-cost
// no-op: no knob / no producer ⇒ NO preview deploy, `proceed` immediately.

import type { EventName, EventPayload } from "../events/index.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import { finalizeNonPassOutcome, type FinalizeRunState } from "./plannerRunFinalize.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("gate");

/**
 * Run the pre-merge behavior gate for a passing-CI merge candidate. A failing / inconclusive /
 * could-not-complete verification FAILS CLOSED — the run finalizes halted (`halt`) so the merge
 * never proceeds; the land-time `resolveLandTimeBehaviorGate` ALSO blocks on any recorded verdict
 * (defense in depth). `not_applicable` (non-web / no behaviors) and `passed` ⇒ `proceed`. No knob
 * / no producer ⇒ `proceed` immediately (NO preview deploy — the default-off zero-cost no-op).
 */
export async function runPreMergeBehaviorGate(
  input: RunPlannerLoopInput,
  context: PlannerRunContext,
  stage: {
    finalizeRunState: FinalizeRunState;
    appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  },
  headSha: string,
): Promise<"proceed" | "halt"> {
  const producer = input.preMergeBehaviorProducer;
  if (context.preMergeBehaviorGate !== true || producer === undefined) {
    return "proceed";
  }
  const outcome = await producer.produce({
    orgId: context.orgId,
    projectId: context.projectId,
    runId: context.runId,
    specId: context.specId,
    repoUrl: context.repoUrl,
    headSha,
    behaviorIds: context.behaviorIds ?? [],
  });
  if (outcome.kind === "blocked") {
    log.warn("pre-merge behavior gate BLOCKED the merge (fail-closed)", {
      runId: context.runId,
      reason: outcome.reason,
      ...(outcome.recordedRunId !== undefined && { recordedRunId: outcome.recordedRunId }),
    });
    await finalizeNonPassOutcome(
      input,
      stage.finalizeRunState,
      context,
      stage.appendEvent,
      "pre_merge_behavior_unsatisfied",
    );
    return "halt";
  }
  log.info("pre-merge behavior gate cleared", { runId: context.runId, decision: outcome.kind });
  return "proceed";
}
