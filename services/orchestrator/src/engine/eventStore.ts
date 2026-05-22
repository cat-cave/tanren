import type pg from "pg";
import { assertEventName, type EventName } from "./events.js";

type EventStoreClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AppendEventInput {
  runId: string;
  taskId?: string;
  specId: string;
  projectId: string;
  eventType: EventName | string;
  payload: unknown;
}

export interface EventStore {
  append(input: AppendEventInput): Promise<void>;
}

export class PgEventStore implements EventStore {
  constructor(private readonly pool: EventStoreClient) {}

  async append(input: AppendEventInput): Promise<void> {
    assertEventName(input.eventType);
    await this.pool.query(
      `INSERT INTO events (run_id, task_id, spec_id, project_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.runId,
        input.taskId ?? null,
        input.specId,
        input.projectId,
        input.eventType,
        JSON.stringify(input.payload)
      ]
    );
  }
}

export class FakeEventStore implements EventStore {
  readonly events: AppendEventInput[] = [];

  async append(input: AppendEventInput): Promise<void> {
    assertEventName(input.eventType);
    this.events.push(input);
  }
}
