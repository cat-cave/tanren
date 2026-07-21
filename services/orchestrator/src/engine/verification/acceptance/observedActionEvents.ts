import type { AcceptanceEventSink } from "./eventSink.js";
import { withoutCausalApiTriggers, type AcceptancePlan } from "./acceptancePlan.js";

/** Append only HTTP probes a live API driver confirmed it executed. */
export async function emitObservedApiActions(input: {
  readonly events: AcceptanceEventSink;
  readonly orgId: string;
  readonly projectId: string;
  readonly plan: AcceptancePlan;
}): Promise<void> {
  for (const probe of withoutCausalApiTriggers(input.plan).httpProbes ?? []) {
    await input.events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.action.observed",
      payload: {
        behaviorRevisionId: input.plan.behaviorRevisionId,
        shardId: `${input.plan.planId}:0`,
        actionId: probe.probeId,
        surface: "api",
      },
    });
  }
}
