// Test-only in-memory EventStore. This used to live in production source
// (`engine/eventStore.ts`) next to PgEventStore; it has been moved here so the
// production module ships only the real Postgres-backed store. Tests construct
// the fake from this fixture instead.
import { assertEventName, EventRegistry, type EventName, type EventPayload } from "../../src/engine/events/index.js";
import type { AppendEventInput, EventStore, RecordedEvent } from "../../src/engine/eventStore.js";

function parseEventPayload<N extends EventName>(eventType: N, payload: unknown): EventPayload<N> {
  const schema = EventRegistry[eventType];
  // The cast is safe: schema is the Zod source-of-truth for this event name.
  return schema.parse(payload) as EventPayload<N>;
}

/**
 * In-memory EventStore that captures appended events in order. Mirrors
 * PgEventStore's parse/assert contract (it rejects unknown event names and bad
 * payload shapes) but keeps rows in `events` instead of writing to Postgres.
 */
export class FakeEventStore implements EventStore {
  readonly events: RecordedEvent[] = [];

  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    assertEventName(input.eventType);
    const parsed = parseEventPayload(input.eventType, input.payload);
    this.events.push({
      runId: input.runId,
      taskId: input.taskId,
      specId: input.specId,
      projectId: input.projectId,
      eventType: input.eventType,
      payload: parsed,
    } as RecordedEvent<N>);
  }
}
