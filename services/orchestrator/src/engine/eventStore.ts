import { notifyEventAppended, notifyRunActivity } from "@tanren/db";
import type pg from "pg";
import { resolveWritableClient } from "./data/orgScopedDb.js";
import { assertEventName, EventRegistry, type EventName, type EventPayload } from "./events/index.js";

type EventStoreClient = Pick<pg.Pool | pg.PoolClient, "query">;

// AppendEventInput is generic over the event name so the compiler enforces
// that the payload matches the registered Zod schema for that event. The
// constructor also accepts a bare `string` name for callers that build the
// name dynamically; the runtime parser rejects unknown names and bad payloads.
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

/**
 * The set of TERMINAL `task.*` event types the `events_task_terminal_unique`
 * partial unique index covers (task #40 Class B). A re-insert of the SAME
 * terminal type for the same `task_id` conflicts cleanly under
 * `ON CONFLICT DO NOTHING`; any OTHER event type uses {@link PgEventStore.append}
 * — the non-terminal stream still needs every append landing (the timeline
 * carries every transition, not just the last).
 */
const TERMINAL_TASK_EVENT_TYPES_FOR_INDEX = new Set<string>(["task.completed", "task.failed", "task.cancelled"]);

function parseEventPayload<N extends EventName>(eventType: N, payload: unknown): EventPayload<N> {
  const schema = EventRegistry[eventType];
  // The payload IS Zod-decoded here (the registry schema is the source-of-truth for
  // this event name) — this is a VALIDATION, not a launder. The trailing narrow is a
  // generic-indexing assist only: TS can't infer that the registry-indexed schema's
  // output is `EventPayload<N>` for the generic `N`, so the parsed (already-validated)
  // value is narrowed to the indexed type. Kept off the `.parse(...) as T` one-liner
  // form so the no-pg-as-date lint reads it as the decode-then-narrow it is.
  const parsed: unknown = schema.parse(payload);
  return parsed as EventPayload<N>;
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

  /**
   * Conditional append for the TERMINAL `task.*` event types (task #40 Class B):
   * issues the SAME insert as {@link append} but with `ON CONFLICT DO NOTHING`
   * against the partial unique index `events_task_terminal_unique`
   * `(task_id, event_type) WHERE event_type IN ('task.completed','task.failed','task.cancelled')`.
   *
   * Returns:
   *   - `true`  — the row LANDED (this caller wrote it; both `tanren_run` +
   *     `tanren_event` NOTIFYs fire on the SAME transaction as the INSERT,
   *     identical to {@link append}).
   *   - `false` — the row already existed (`ON CONFLICT DO NOTHING` matched);
   *     no NOTIFYs fire (the ORIGINAL INSERT already fired its NOTIFYs at the
   *     ORIGINAL commit time — re-firing here would wake the SSE / dispatcher
   *     a SECOND time for an event that was already delivered).
   *
   * Restricted to the terminal task-event set the partial unique index covers;
   * a non-terminal event passed here would silently degrade to a never-conflicts
   * INSERT (the index excludes it), so this throws loud rather than masking a
   * wiring bug. Callers append non-terminal events through {@link append} as before.
   */
  async appendIfAbsent<N extends EventName>(input: AppendEventInput<N>): Promise<boolean> {
    assertEventName(input.eventType);
    if (!TERMINAL_TASK_EVENT_TYPES_FOR_INDEX.has(input.eventType)) {
      throw new Error(
        `PgEventStore.appendIfAbsent: event type ${input.eventType} is not covered by the events_task_terminal_unique partial index — use append() for non-terminal events`,
      );
    }
    const parsed = parseEventPayload(input.eventType, input.payload);
    const client = resolveWritableClient(this.pool);
    const inserted = await client.query<{ id: string }>(
      // ON CONFLICT (task_id, event_type) WHERE ... is INFERRED via the partial
      // unique index `events_task_terminal_unique`; an unqualified
      // `ON CONFLICT DO NOTHING` is sufficient and lets PG pick the matching
      // arbiter index by the index-predicate it already has.
      `INSERT INTO events (run_id, task_id, spec_id, project_id, org_id, event_type, payload)
       VALUES ($1, $2, $3, $4, (SELECT org_id FROM projects WHERE project_id = $4), $5, $6::jsonb)
       ON CONFLICT DO NOTHING
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
    const eventId = inserted.rows[0]?.id;
    if (eventId === undefined) {
      // Conflict path: the original INSERT already landed + already NOTIFY'd at
      // its own commit. Returning false is the at-most-once signal the caller
      // surfaces upstream (the seam's `alreadyTerminal: true` outcome). NO NOTIFY
      // here — the SSE / dispatcher already observed the original event.
      return false;
    }
    if (input.runId !== undefined) {
      await notifyRunActivity(client, input.runId);
    }
    await notifyEventAppended(client, eventId);
    return true;
  }
}
