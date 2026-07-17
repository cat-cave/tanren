// The NotificationSubscriber: the production wiring that makes notifications
// actually reach a human. A long-lived per-process listener that wakes on the
// `tanren_notify` bus — fired at the event-append seam (PgEventStore) for EVERY
// appended event, carrying only the event's bigserial id. On each wake it
// re-reads that single event row under the system scope (the payload is just an
// id, so the wake leaks no tenant data), replays every event after its
// in-memory dispatch watermark, decodes each one to a typed event + its
// org/run/spec/project context, and hands it to the NotificationDispatcher.
//
// Postgres NOTIFY is only a wake, not a durable queue: a commit during the
// boot / reconnect gap is never delivered to a listener that was not LISTENing
// at that instant. The replay on every successful subscribe, plus the long
// safety-net cadence below, makes that gap at-least-once rather than silent.
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
import { subscribeWithReconnect, type SubscribeWithReconnectHandle } from "../db/notifySubscriber.js";

const log = createLogger("notifications");

/** The event row the subscriber re-reads by id to rebuild a typed event + its context. */
interface NotificationEventRow {
  id: string;
  event_type: string;
  payload: unknown;
  org_id: string | null;
  run_id: string | null;
  spec_id: string | null;
  project_id: string | null;
  user_id: string | null;
}

// Like the run-worker's 20s claim backstop, this is a cadence rather than a
// deadline: LISTEN is the low-latency wake path and this scan repairs a missed
// wake (including a PG failover reconnect gap) within a bounded interval.
const CATCH_UP_INTERVAL_MS = 20_000;

export interface NotificationSubscriberDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (its own, so it never contends with the other subscribers' pumps). */
  notifyListener: PgNotifyListener;
  /** The dispatcher to drive — constructed ONCE by the boot (channel registry + deps). */
  dispatcher: NotificationDispatcher;
}

/**
 * The running subscriber handle: every wake, successful (re)subscribe, and
 * safety-net cadence replays the event tail after its dispatch watermark.
 * `stop()` unsubscribes (idempotent). Replay is intentionally at-least-once;
 * the dispatch ledger is the idempotency boundary.
 */
export class NotificationSubscriber {
  private reconnectHandle: SubscribeWithReconnectHandle | undefined;
  private catchUpTimer: ReturnType<typeof setInterval> | undefined;
  private catchUpInFlight: Promise<void> | undefined;
  private catchUpRequested = false;
  // This process-local watermark is advanced only after the event row has been
  // handed to the dispatcher. Starting at zero deliberately lets the first
  // successful LISTEN replay rows committed before that LISTEN resolved; the
  // notification ledger / channels tolerate at-least-once delivery.
  private lastDispatchedEventId = "0";
  private stopped = false;

  constructor(private readonly deps: NotificationSubscriberDeps) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.startCatchUpPoll();
    this.subscribeToNotifyBus();
  }

  /**
   * Subscribe to the notification bus via the shared `subscribeWithReconnect`
   * helper (audit C2 #4-#7): the helper drives an UNBOUNDED progress-spaced
   * retry on both the initial subscribe AND on a live connection drop, so a
   * boot-time PG blip no longer silently collapses the "never silently drop a
   * fail-severity event" invariant — the escalation path used to log-and-degrade
   * forever after a single boot-time subscribe throw.
   */
  private subscribeToNotifyBus(): void {
    const handle = subscribeWithReconnect({
      listener: this.deps.notifyListener,
      channel: NOTIFICATION_CHANNEL,
      logger: log,
      handler: (payload) => {
        // A wake has no durable ordering guarantee across a reconnect. Replay
        // from the watermark instead of reading only this one payload id.
        this.requestCatchUp("notify", payload);
      },
      // `subscribeWithReconnect` calls this after EVERY successful LISTEN,
      // including a re-subscribe following a PG connection error. That closes
      // the otherwise-lost interval between the old client dropping and the
      // replacement client becoming live.
      onSubscribed: () => this.requestCatchUp("subscribe"),
    });
    if (this.stopped) {
      // stop() raced the wiring: drain the helper in the background — the
      // outer `stop()` promise is the authoritative drain. Fire-and-forget is
      // safe (helper stop is idempotent + cached).
      void handle.stop();
      return;
    }
    this.reconnectHandle = handle;
  }

  /**
   * Stop listening. Idempotent; an in-flight dispatch finishes on its own.
   * Returns a promise that resolves AFTER the reconnect helper's own drain
   * settles (it waits for the in-flight `PgNotifyListener.subscribe(…)` to
   * resolve/throw), so a `await stop(); await start();` sequence never leaves
   * two live handler sets on the shared listener for a tick (Codex RA1).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.catchUpTimer !== undefined) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = undefined;
    }
    const drain = this.reconnectHandle?.stop();
    this.reconnectHandle = undefined;
    if (drain !== undefined) await drain;
  }

  /** Start the interval-based missed-NOTIFY backstop. */
  private startCatchUpPoll(): void {
    if (this.catchUpTimer !== undefined) return;
    this.catchUpTimer = setInterval(() => this.requestCatchUp("safety-net"), CATCH_UP_INTERVAL_MS);
    this.catchUpTimer.unref?.();
  }

  /**
   * Coalesce concurrent wake / subscribe / poll requests. A request that lands
   * while the scan is reading is latched, so the running pass immediately scans
   * once more rather than leaving a just-committed row to the next cadence.
   */
  private requestCatchUp(source: "notify" | "subscribe" | "safety-net", eventId?: string): void {
    if (this.stopped || eventId === "") return;
    if (this.catchUpInFlight !== undefined) {
      this.catchUpRequested = true;
      return;
    }
    const catchUp = this.catchUp();
    this.catchUpInFlight = catchUp;
    void catchUp.then(
      () => {
        if (this.catchUpInFlight === catchUp) this.catchUpInFlight = undefined;
      },
      (error: unknown) => {
        if (this.catchUpInFlight === catchUp) this.catchUpInFlight = undefined;
        log.error("notification catch-up failed", { source, eventId }, error);
      },
    );
  }

  /** Replay all durable event rows after the last successfully dispatched id. */
  private async catchUp(): Promise<void> {
    do {
      this.catchUpRequested = false;
      const rows = await this.readEventsAfter(this.lastDispatchedEventId);
      for (const row of rows) {
        await this.dispatchEvent(row);
        this.lastDispatchedEventId = row.id;
      }
    } while (this.catchUpRequested && !this.stopped);
  }

  /** Decode and dispatch a single event row while retaining the ordered watermark. */
  private async dispatchEvent(row: NotificationEventRow): Promise<void> {
    let event: TypedEvent;
    try {
      event = decodeEvent({ event_type: row.event_type, payload: row.payload });
    } catch (error) {
      // An unknown/unparseable event type is a defensive guard only — every
      // producer writes through the validated PgEventStore — but never let it
      // block delivery of the rest. Log and move on.
      log.error("could not decode appended event", { eventId: row.id, eventType: row.event_type }, error);
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
   * Read the durable event tail under the system scope. The wake itself carries
   * no org (and may have been missed), so this cross-org scan is keyed only by
   * the monotonic event id; the dispatcher re-applies each event's org scope.
   */
  private async readEventsAfter(eventId: string): Promise<NotificationEventRow[]> {
    const readPool = getSystemPool() ?? this.deps.pool;
    return runWithSystemScope(readPool, async (client) => {
      const result = await client.query<NotificationEventRow>(
        `SELECT id::text AS id, event_type, payload, org_id, run_id, spec_id, project_id, user_id
           FROM events
          WHERE id > $1::bigint
          ORDER BY id ASC`,
        [eventId],
      );
      return result.rows;
    });
  }
}

/** Build + start the NotificationSubscriber from the worker boot. */
export async function startNotificationSubscriber(deps: NotificationSubscriberDeps): Promise<NotificationSubscriber> {
  const subscriber = new NotificationSubscriber(deps);
  await subscriber.start();
  return subscriber;
}
