// Test-only in-memory EventStore. Lives in `tests/` so production source
// (`src/engine/eventStore.ts`) never ships the fake — that file defines only
// `PgEventStore` (including its Postgres NOTIFY path). Tests that need to assert
// on emitted events without a database import `FakeEventStore` from here.

import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import { assertEventName, EventRegistry, type EventName, type EventPayload } from "../../src/engine/events/index.js";

function parseEventPayload<N extends EventName>(eventType: N, payload: unknown): EventPayload<N> {
  const schema = EventRegistry[eventType];
  // The cast is safe: schema is the Zod source-of-truth for this event name.
  return schema.parse(payload) as EventPayload<N>;
}

export interface RecordedEvent<N extends EventName = EventName> {
  runId: string;
  taskId?: string;
  specId: string;
  projectId: string;
  eventType: N;
  payload: EventPayload<N>;
}

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
