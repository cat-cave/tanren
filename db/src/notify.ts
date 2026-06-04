// LISTEN/NOTIFY: the event-driven wake mechanism that replaces the hot 1s polls.
//
// Two hot paths used to poll Postgres on a fixed 1s tick:
//   - the run worker, polling `job_queue` for the next claimable `plan` job;
//   - the SSE frame source, polling runs/tasks/events/costs for a watched run.
// Both now WAKE on a Postgres `NOTIFY` emitted at the producing write seam and
// keep only a long (15–30s) safety-net poll as a missed-notification backstop.
//
// Two channels:
//   - `tanren_job_queue` — fired (no payload) whenever a job is enqueued, so an
//     idle worker slot wakes and re-attempts a claim. It is cross-tenant on
//     purpose: the queue itself is cross-tenant (the worker claims under the
//     system scope), and the notification carries NO data — it is a bare "work
//     may be available" pulse, so it leaks nothing.
//   - `tanren_run` — fired with the `run_id` as the payload whenever a watched
//     run's state changes (run-state write, event append). An SSE listener for
//     run X filters on the payload so it wakes only on run X's activity. The
//     payload is ONLY the run id — never tenant data — so a listener that woke
//     on it must still re-query under its own org scope (RLS) to read the row;
//     the notification cannot leak cross-tenant content.
//
// NOTIFY is delivered at COMMIT, so emitting it on the SAME client/transaction
// as the producing write means the wake fires exactly when (and only if) the
// write is durable. A rolled-back write emits no notification.
//
// `assertSafePayloadId` guards an id before it is interpolated into the NOTIFY
// payload literal (NOTIFY cannot bind parameters), mirroring `assertSafeOrgId`
// in orgScope.ts — a malformed id is rejected loudly rather than smuggling SQL
// into the notify statement.

import type { Pool, PoolClient } from "pg";

/** Cross-tenant pulse fired on job enqueue; carries no payload (just "wake"). */
export const JOB_QUEUE_CHANNEL = "tanren_job_queue";

/** Per-run activity channel; the NOTIFY payload is the run id (and nothing else). */
export const RUN_ACTIVITY_CHANNEL = "tanren_run";

/**
 * Notification channel; the NOTIFY payload is the appended event's id (and
 * nothing else). Fired at the event-append seam for EVERY event — including the
 * PROJECT-scoped events (e.g. `dag.spec.needs_attention`) that carry no run id
 * and therefore emit no per-run `tanren_run` wake. The notification dispatcher
 * subscriber wakes on this channel, re-reads the single event row by id under
 * the system scope (the payload carries no tenant data, so the wake leaks
 * nothing), decodes it to a typed event, and fans it out to the configured
 * channels. This is the seam that makes escalations actually reach a human:
 * without a wake on EVERY event, a `needs_attention` (no run id) would never be
 * dispatched. A numeric bigserial id is safe in the NOTIFY payload literal.
 */
export const NOTIFICATION_CHANNEL = "tanren_notify";

/**
 * DAG-change channel; the NOTIFY payload is the project id (and nothing else).
 * Fired whenever a spec is inserted for a project (derive / discovery-accept /
 * plain create), so the DagWalker subscriber wakes and walks THAT project the
 * instant its DAG gains a ready spec — without a manual trigger or worker reboot
 * (a freshly-derived DAG has pending specs but ZERO runs, so the run-activity
 * channel never fires for it). The payload is ONLY the project id — never tenant
 * data — so a listener that woke on it re-reads the project's specs under the
 * system scope (the walker is cross-org, like the worker bootstrap).
 */
export const DAG_CHANGE_CHANNEL = "tanren_dag";

/** Anything that can issue a NOTIFY — the pool or a checked-out client. */
type NotifyClient = Pick<Pool | PoolClient, "query">;

/**
 * Guard an id before it is interpolated into the NOTIFY payload literal.
 * Our ids are `<kind>_<uuid>` slugs; reject anything else so a malformed id can
 * never inject SQL into the un-parameterizable NOTIFY statement.
 */
function assertSafePayloadId(id: string): void {
  if (!/^[A-Za-z0-9_:.-]+$/u.test(id)) {
    throw new Error(`unsafe id for NOTIFY payload: ${JSON.stringify(id)}`);
  }
}

/**
 * Emit the job-queue wake pulse on `client`. Call it at the job_queue INSERT
 * seam so an idle worker slot wakes the moment a job is enqueued (delivered at
 * COMMIT alongside the insert). No payload — it is a bare "work may be
 * available" signal; the worker re-attempts a (system-scoped) claim on wake.
 */
export async function notifyJobEnqueued(client: NotifyClient): Promise<void> {
  await client.query(`NOTIFY ${JOB_QUEUE_CHANNEL}`);
}

/**
 * Emit a run-activity wake for `runId` on `client`. Call it at every run-state
 * write seam (event append, run finalize, etc.) so an SSE stream watching this
 * run wakes and re-queries its deltas. The payload is ONLY the run id — the
 * listener re-reads the run's rows under its own org scope, so the notification
 * carries no tenant data across the wire.
 */
export async function notifyRunActivity(client: NotifyClient, runId: string): Promise<void> {
  assertSafePayloadId(runId);
  // NOTIFY cannot bind parameters; runId is validated above. Single-quote the
  // literal (the id charset excludes `'`, so no embedded-quote escaping needed).
  await client.query(`NOTIFY ${RUN_ACTIVITY_CHANNEL}, '${runId}'`);
}

/**
 * Emit a DAG-change wake for `projectId` on `client`. Call it at the spec INSERT
 * seam so the DagWalker subscriber wakes and walks this project the moment its
 * DAG gains a (pending) spec — covering the greenfield-derive, discovery-accept,
 * brownfield-seed, and plain create paths, which a freshly-created project has no
 * run to trigger off of. Delivered at COMMIT, so the wake fires exactly when the
 * spec row is visible (a rolled-back insert emits no notification). The payload
 * is ONLY the project id; the subscriber re-reads the DAG under the system scope.
 */
export async function notifyDagChanged(client: NotifyClient, projectId: string): Promise<void> {
  assertSafePayloadId(projectId);
  // NOTIFY cannot bind parameters; projectId is validated above. Single-quote
  // the literal (the id charset excludes `'`, so no embedded-quote escaping).
  await client.query(`NOTIFY ${DAG_CHANGE_CHANNEL}, '${projectId}'`);
}

/**
 * Emit a notification wake for the appended event `eventId` on `client`. Call it
 * at the event-append seam (PgEventStore) AFTER the INSERT so the notification
 * dispatcher wakes for EVERY event — including project-scoped escalations
 * (`dag.spec.needs_attention`) that carry no run id and thus fire no
 * `tanren_run` wake. Delivered at COMMIT on the SAME transaction as the INSERT,
 * so the wake fires exactly when the row is visible (a rolled-back append emits
 * no notification). The payload is ONLY the event's bigserial id — the
 * subscriber re-reads the row under the system scope, so no tenant data crosses
 * the wire. The id is a positive integer; assert it so a malformed value can
 * never inject SQL into the un-parameterizable NOTIFY statement.
 */
export async function notifyEventAppended(client: NotifyClient, eventId: string): Promise<void> {
  if (!/^[0-9]+$/u.test(eventId)) {
    throw new Error(`unsafe event id for NOTIFY payload: ${JSON.stringify(eventId)}`);
  }
  await client.query(`NOTIFY ${NOTIFICATION_CHANNEL}, '${eventId}'`);
}

/** A subscriber's wake callback. Receives the NOTIFY payload (empty string when none). */
export type NotifyHandler = (payload: string) => void;

/**
 * A dedicated long-lived LISTEN connection. Holds ONE pooled client open,
 * issues `LISTEN` for each subscribed channel, and fans every inbound
 * notification out to the channel's registered handlers. On a connection error
 * it reconnects and re-LISTENs every still-subscribed channel — the safety-net
 * poll on each consumer covers the (sub-second) reconnect gap, so a dropped
 * connection degrades to "poll cadence" rather than a missed wake.
 *
 * One listener per process is enough: many SSE streams can `subscribe` to the
 * same `tanren_run` channel and filter by run id in their handler. The single
 * held connection is the intended cost — NOT a per-stream connection.
 */
export class PgNotifyListener {
  private client: PoolClient | undefined;
  private readonly handlers = new Map<string, Set<NotifyHandler>>();
  private connecting: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly pool: Pool) {}

  /**
   * Register `handler` for `channel`, ensuring the listener is connected and
   * `LISTEN`ing on it. Returns an unsubscribe function; when the last handler
   * for a channel unsubscribes the channel is `UNLISTEN`ed. Safe to call before
   * the connection is established — it lazily connects on first subscribe.
   */
  async subscribe(channel: string, handler: NotifyHandler): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    await this.ensureConnected();
    await this.client?.query(`LISTEN ${quoteIdent(channel)}`);
    return () => {
      const current = this.handlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        // Best-effort UNLISTEN; a dropped connection already cleared it.
        void this.client?.query(`UNLISTEN ${quoteIdent(channel)}`).catch(() => {});
      }
    };
  }

  /** Close the held connection and drop all subscriptions. Idempotent. */
  close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) {
      client.removeAllListeners("notification");
      client.removeAllListeners("error");
      client.release();
    }
    return Promise.resolve();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed || this.client !== undefined) return;
    if (this.connecting === undefined) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.on("notification", (msg) => {
      const set = this.handlers.get(msg.channel);
      if (set === undefined) return;
      const payload = msg.payload ?? "";
      for (const handler of set) {
        handler(payload);
      }
    });
    client.on("error", () => {
      // Connection dropped: discard it and re-establish + re-LISTEN. The error
      // backstop (each consumer's long safety-net poll) covers the reconnect
      // gap, so a dropped LISTEN degrades to poll cadence, never a wedged stream.
      void this.reconnect(client);
    });
    this.client = client;
    // Re-LISTEN every channel that still has subscribers (covers reconnects).
    for (const channel of this.handlers.keys()) {
      await client.query(`LISTEN ${quoteIdent(channel)}`);
    }
  }

  private async reconnect(stale: PoolClient): Promise<void> {
    if (this.closed) return;
    if (this.client === stale) {
      this.client = undefined;
    }
    stale.removeAllListeners("notification");
    stale.removeAllListeners("error");
    try {
      stale.release();
    } catch {
      // already destroyed
    }
    if (this.handlers.size === 0) return;
    try {
      await this.ensureConnected();
    } catch {
      // Reconnect failed; the next subscribe (or a future error) retries. The
      // consumers' safety-net polls keep them live in the meantime.
    }
  }
}

/**
 * Quote a channel identifier for LISTEN/UNLISTEN (which cannot bind params).
 * Our channels are fixed ascii constants, but quoting keeps the helper safe for
 * any caller-supplied channel name.
 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
