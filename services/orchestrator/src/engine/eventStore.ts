import type pg from "pg";
import { resolveWritableClient } from "./data/orgScopedDb.js";
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
    // RLS R2 cohort-1 (events write path): when this store was handed the shared
    // pool, route the INSERT through the ambient org-scoped client if a scope is
    // open (so the write joins the request/job org transaction); fall back to the
    // pool when there is none (inert, R1-equivalent). When handed a specific
    // in-transaction client, use it as-is — the caller owns that transaction.
    const client = resolveWritableClient(this.pool);
    await client.query(
      // org_id is the mandatory tenant-isolation key (tanren tenancy hardening),
      // derived in-statement from the event's project so every event row carries
      // its org directly rather than relying on a route-layer gate or a nullable
      // project_id → projects.org_id hop.
      `INSERT INTO events (run_id, task_id, spec_id, project_id, org_id, event_type, payload)
       VALUES ($1, $2, $3, $4, (SELECT org_id FROM projects WHERE project_id = $4), $5, $6::jsonb)`,
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
