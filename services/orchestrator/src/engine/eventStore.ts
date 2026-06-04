import { notifyEventAppended, notifyRunActivity } from "@tanren/db";
import type pg from "pg";
import { resolveWritableClient } from "./data/orgScopedDb.js";
import { assertEventName, EventRegistry, type EventName, type EventPayload } from "./events/index.js";

type EventStoreClient = Pick<pg.Pool | pg.PoolClient, "query">;

// AppendEventInput is generic over the event name so the compiler enforces
// that the payload matches the registered Zod schema for that event. The
// constructor still accepts a bare `string` for legacy migrate-in-progress
// callers; the runtime parser rejects unknown names and bad payload shapes.
export type AppendEventInput<N extends EventName = EventName> = {
  // run_id / spec_id are nullable on the events table: a PROJECT-scoped event
  // (e.g. the DagWalker's `dag.drained` / `dag.budget.paused`, which describe the
  // project's DAG, not a single run) carries only projectId. A run-scoped event
  // supplies both, exactly as before. The notify wake (tanren_run) fires only
  // when a runId is present — a project-scoped append needs no per-run wake.
  runId?: string;
  taskId?: string;
  specId?: string;
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
    const inserted = await client.query<{ id: string }>(
      // org_id is the mandatory tenant-isolation key (tanren tenancy hardening),
      // derived in-statement from the event's project so every event row carries
      // its org directly rather than relying on a route-layer gate or a nullable
      // project_id → projects.org_id hop.
      `INSERT INTO events (run_id, task_id, spec_id, project_id, org_id, event_type, payload)
       VALUES ($1, $2, $3, $4, (SELECT org_id FROM projects WHERE project_id = $4), $5, $6::jsonb)
       RETURNING id::text AS id`,
      [
        input.runId ?? null,
        input.taskId ?? null,
        input.specId ?? null,
        input.projectId,
        input.eventType,
        JSON.stringify(parsed),
      ],
    );
    // LISTEN/NOTIFY: this is the central run-activity seam. Every run-state
    // change in the engine — queued, task transitions, status/finalize, cost
    // accrual — emits an event through here, so notifying on the run's channel
    // after each append wakes that run's SSE stream and replaces its 1s poll as
    // the primary driver. The notify rides the SAME client (the INSERT's
    // transaction), so it fires at COMMIT — exactly when the row is visible. The
    // payload is ONLY the run id: a listener re-queries the deltas under its own
    // org scope, so the wake leaks no tenant data. A PROJECT-scoped event (no
    // runId — e.g. the DagWalker's drained/paused) has no run stream to wake, so
    // it emits no per-run notify.
    if (input.runId !== undefined) {
      await notifyRunActivity(client, input.runId);
    }
    // Notification fan-out wake: fire on EVERY appended event (carrying only the
    // event's bigserial id) so the notification dispatcher subscriber reaches a
    // human for events that have no run id — most importantly the project-scoped
    // `dag.spec.needs_attention` escalation, which emits no `tanren_run` wake.
    // Delivered at COMMIT on this same transaction; the subscriber re-reads the
    // row under the system scope so no tenant data crosses the wire.
    const eventId = inserted.rows[0]?.id;
    if (eventId !== undefined) {
      await notifyEventAppended(client, eventId);
    }
  }
}
