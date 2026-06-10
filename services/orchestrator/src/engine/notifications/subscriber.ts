// The NotificationSubscriber: the production wiring that makes notifications
// actually reach a human. A long-lived per-process listener that wakes on the
// `tanren_notify` bus — fired at the event-append seam (PgEventStore) for EVERY
// appended event, carrying only the event's bigserial id. On each wake it
// re-reads that single event row under the system scope (the payload is just an
// id, so the wake leaks no tenant data), decodes it to a typed event + its
// org/run/spec/project context, and hands it to the NotificationDispatcher.
//
// Why a dedicated channel rather than reusing `tanren_run`: the highest-signal
// escalation — `dag.spec.needs_attention` (a conflict/strand parked for a human)
// — is PROJECT-scoped and carries no run id, so PgEventStore emits no
// `tanren_run` wake for it. Keying notifications off `tanren_run` would silently
// drop exactly the events that most need to reach a person. `tanren_notify`
// fires on every append, so nothing is missed.
//
// The dispatcher is the rate/relevance gate (the matrix + severity filter), so
// this subscriber dispatches EVERY event and lets the dispatcher decide whether
// any human is notified. Routine low-severity lifecycle events match no route
// and notify no one (no spam); a fail-severity escalation lands.
//
// The event wake carries only a row id, not an org id, so the single-row lookup
// uses the system pool. Tenant-scoped dispatcher work is re-entered under the
// event's org before reading routes or writing notification rows.

import {
  NOTIFICATION_CHANNEL,
  type PgNotifyListener,
  getSystemPool,
  runWithJobOrgId,
  runWithSystemScope,
} from "@tanren/db";
import type pg from "pg";
import { decodeEvent, type TypedEvent } from "../events/index.js";
import type { NotificationDispatcher, EventContext } from "./dispatcher.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("notifications");

/** The event row the subscriber re-reads by id to rebuild a typed event + its context. */
interface NotificationEventRow {
  event_type: string;
  payload: unknown;
  org_id: string | null;
  run_id: string | null;
  spec_id: string | null;
  project_id: string | null;
  user_id: string | null;
}

export interface NotificationSubscriberDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (its own, so it never contends with the other subscribers' pumps). */
  notifyListener: PgNotifyListener;
  /** The dispatcher to drive — constructed ONCE by the boot (channel registry + deps). */
  dispatcher: NotificationDispatcher;
}

/**
 * The running subscriber handle: on every `tanren_notify` wake it reads the
 * appended event row and dispatches it. `stop()` unsubscribes (idempotent).
 * Each wake is independent (one event id per notify), so there is no per-key
 * coalescing — every appended event is dispatched exactly once.
 */
export class NotificationSubscriber {
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly deps: NotificationSubscriberDeps) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    void this.subscribeInBackground();
  }

  private async subscribeInBackground(): Promise<void> {
    try {
      const unsubscribe = await this.deps.notifyListener.subscribe(NOTIFICATION_CHANNEL, (payload) => {
        // Fire-and-forget: a dispatch failure is logged, never thrown into the
        // notify pump (and the dispatcher itself never throws on a channel error).
        void this.onEventAppended(payload).catch((error: unknown) => {
          log.error("dispatch failed", { eventId: payload }, error);
        });
      });
      if (this.stopped) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
    } catch (error) {
      log.error("failed to subscribe to the notify bus (will not deliver)", {}, error);
    }
  }

  /** Stop listening. Idempotent; an in-flight dispatch finishes on its own. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Handle one `tanren_notify` wake: read the event row by id and dispatch it. */
  private async onEventAppended(eventId: string): Promise<void> {
    if (eventId === "") return;
    const row = await this.readEvent(eventId);
    if (row === undefined) return;
    let event: TypedEvent;
    try {
      event = decodeEvent({ event_type: row.event_type, payload: row.payload });
    } catch (error) {
      // An unknown/unparseable event type is a defensive guard only — every
      // producer writes through the validated PgEventStore — but never let it
      // block delivery of the rest. Log and move on.
      log.error("could not decode appended event", { eventId, eventType: row.event_type }, error);
      return;
    }
    const context: EventContext = {
      orgId: row.org_id,
      actorUserId: row.user_id,
      runId: row.run_id,
      specId: row.spec_id,
      projectId: row.project_id,
    };
    // A null-org (system) event is skipped by the dispatcher anyway — call it
    // directly. A tenant event runs under the event's per-job org scope so the
    // dispatcher's matrix read + ledger write self-route through the org-scoping
    // pool (under enforced RLS an unscoped tenant read sees zero rows).
    if (row.org_id === null) {
      await this.deps.dispatcher.onEvent(event, context);
      return;
    }
    await runWithJobOrgId(row.org_id, () => this.deps.dispatcher.onEvent(event, context));
  }

  /**
   * Read the appended event row by id. The system scope is cross-org because the
   * wake carries no org, so this is a bare id lookup; the dispatcher re-applies the
   * event org scope when it loads the matrix.
   */
  private async readEvent(eventId: string): Promise<NotificationEventRow | undefined> {
    const readPool = getSystemPool() ?? this.deps.pool;
    return runWithSystemScope(readPool, async (client) => {
      const result = await client.query<NotificationEventRow>(
        `SELECT event_type, payload, org_id, run_id, spec_id, project_id, user_id
           FROM events
          WHERE id = $1::bigint`,
        [eventId],
      );
      return result.rows[0];
    });
  }
}

/** Build + start the NotificationSubscriber from the worker boot. */
export async function startNotificationSubscriber(deps: NotificationSubscriberDeps): Promise<NotificationSubscriber> {
  const subscriber = new NotificationSubscriber(deps);
  await subscriber.start();
  return subscriber;
}
