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
 * The project opted INTO the pre-merge behavior gate (`preMergeBehaviorGate: true`) but no
 * producer is wired for the run — a wiring/config gap. FAIL-CLOSED (never a silent proceed): the
 * operator asked for the gate, so if it cannot run the merge must NOT pass. Thrown LOUD so the
 * run's error boundary finalizes it failed rather than merging an unverified candidate.
 */
export class PreMergeBehaviorGateMisconfiguredError extends Error {
  public override readonly name = "PreMergeBehaviorGateMisconfiguredError";
  public constructor(public readonly runId: string) {
    super(
      `pre-merge behavior gate is ON for run '${runId}' but no producer is wired — fail-closed ` +
        "(the opted-in gate cannot be silently bypassed)",
    );
  }
}

/**
 * Run the pre-merge behavior gate for a passing-CI merge candidate. A failing / inconclusive /
 * could-not-complete verification FAILS CLOSED — the run finalizes halted (`halt`) so the merge
 * never proceeds; the land-time `resolveLandTimeBehaviorGate` ALSO blocks on any recorded verdict
 * (defense in depth). `not_applicable` (non-web / no behaviors) and `passed` ⇒ `proceed`. Knob OFF
 * ⇒ `proceed` immediately (NO preview deploy — the default-off zero-cost no-op). Knob ON but the
 * producer is UNWIRED ⇒ a fail-closed {@link PreMergeBehaviorGateMisconfiguredError} (never a
 * silent bypass of the gate the operator opted into).
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
  // Knob OFF ⇒ zero-cost no-op (no preview deploy), regardless of whether a producer is wired.
  if (context.preMergeBehaviorGate !== true) {
    return "proceed";
  }
  // Knob ON but no producer ⇒ MISCONFIGURATION. Fail-closed LOUD — never proceed past an
  // opted-in gate that cannot run.
  if (producer === undefined) {
    log.error("pre-merge behavior gate is ON but no producer is wired — failing closed", {
      runId: context.runId,
    });
    throw new PreMergeBehaviorGateMisconfiguredError(context.runId);
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
