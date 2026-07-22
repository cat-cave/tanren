import type { AcceptanceEventSink } from "./eventSink.js";
import type { DriverObservation } from "../../contracts/runtimeVerificationAdapters.js";

/**
 * Append one action fact for each real API-driver observation. The driver result
 * is the evidence source; a planned probe is never an observed action.
 */
export async function emitObservedApiActions(input: {
  readonly events: AcceptanceEventSink;
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviorRevisionId: string;
  /** The runtime coordinate assigned to the executing shard. */
  readonly shardId: string;
  readonly observations: readonly DriverObservation[];
}): Promise<void> {
  for (const observation of input.observations) {
    const actionId = actionIdFromObservedSubject(observation.subject);
    // An observation without a representable action coordinate cannot truthfully
    // populate this event's strict actionId field, so it is left un-emitted.
    if (actionId === undefined) continue;
    await input.events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.action.observed",
      payload: {
        behaviorRevisionId: input.behaviorRevisionId,
        shardId: input.shardId,
        actionId,
        surface: "api",
      },
    });
  }
}

function actionIdFromObservedSubject(subject: string): string | undefined {
  const [actionId] = subject.split(".", 1);
  return actionId === undefined || actionId.length === 0 || actionId.length > 256 ? undefined : actionId;
}
