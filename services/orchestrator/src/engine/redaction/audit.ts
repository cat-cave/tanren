import type { ActorContext } from "../../auth/schemas.js";
import type { EventStore } from "../eventStore.js";
import type { EventName } from "../events/registry.js";

// emitRedactionAudit writes a `redaction.raw_access` event recording that an
// elevated-scope actor read raw payload values. The redaction layer is the
// single legitimate emitter; production code outside the redaction module
// must not call this directly (the single-event-writer architecture check
// already restricts events.append() to the event store, which this routes
// through).
//
// Callers pass the (runId, taskId, specId, projectId) of the event the
// actor *read*, so the audit is correlated with the original event row in
// the same partition. eventReadType + eventReadId let later forensic
// queries pivot from "who saw what" to "which payloads were read raw".

export interface RedactionAuditInput {
  store: EventStore;
  actor: ActorContext;
  // Provenance of the event being read.
  runId: string;
  specId: string;
  projectId: string;
  taskId?: string;
  eventReadId: string;
  eventReadType: EventName | string;
  paths: ReadonlyArray<string>;
  // Optional: override timestamp (defaults to now). Tests pin this.
  now?: () => Date;
}

export async function emitRedactionAudit(input: RedactionAuditInput): Promise<void> {
  if (input.paths.length === 0) {
    // No raw paths were actually returned, so no privileged read occurred.
    // Auditing a no-op would spam the timeline.
    return;
  }
  const at = (input.now ?? defaultNow)().toISOString();
  await input.store.append({
    runId: input.runId,
    taskId: input.taskId,
    specId: input.specId,
    projectId: input.projectId,
    eventType: "redaction.raw_access",
    payload: {
      actorUserId: input.actor.userId,
      actorScopes: [...input.actor.scopes],
      eventReadId: input.eventReadId,
      eventReadType: input.eventReadType,
      paths: [...input.paths],
      at,
    },
  });
}

function defaultNow(): Date {
  return new Date();
}
