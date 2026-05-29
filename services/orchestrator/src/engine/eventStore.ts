import type pg from "pg";
import { assertEventName, EventRegistry, type EventName, type EventPayload } from "./events/index.js";

type EventStoreClient = Pick<pg.Pool | pg.PoolClient, "query">;

// AppendEventInput is generic over the event name so the compiler enforces
// that the payload matches the registered Zod schema for that event. The
// constructor still accepts a bare `string` for legacy migrate-in-progress
// callers; the runtime parser rejects unknown names and bad payload shapes.
export type AppendEventInput<N extends EventName = EventName> = {
  runId: string;
  taskId?: string;
  specId: string;
  projectId: string;
  eventType: N;
  payload: EventPayload<N>;
};

export interface EventStore {
  append<N extends EventName>(input: AppendEventInput<N>): Promise<void>;
}

function parseEventPayload<N extends EventName>(eventType: N, payload: unknown): EventPayload<N> {
  const schema = EventRegistry[eventType];
  // The cast is safe: schema is the Zod source-of-truth for this event name.
  return schema.parse(payload) as EventPayload<N>;
}

export class PgEventStore implements EventStore {
  constructor(private readonly pool: EventStoreClient) {}

  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    assertEventName(input.eventType);
    const parsed = parseEventPayload(input.eventType, input.payload);
    await this.pool.query(
      `INSERT INTO events (run_id, task_id, spec_id, project_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [input.runId, input.taskId ?? null, input.specId, input.projectId, input.eventType, JSON.stringify(parsed)],
    );
  }
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
