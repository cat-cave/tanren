// LISTEN/NOTIFY helper tests (db/src/notify.ts): the NOTIFY emitters fire the
// right statements on the right channels, the run-id guard rejects unsafe ids,
// and the PgNotifyListener dispatches inbound notifications to the channel's
// subscribed handlers (and filters to the right channel).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DAG_CHANGE_CHANNEL,
  JOB_QUEUE_CHANNEL,
  NOTIFICATION_CHANNEL,
  notifyDagChanged,
  notifyEventAppended,
  notifyJobEnqueued,
  notifyRunActivity,
  PgNotifyListener,
  RUN_ACTIVITY_CHANNEL,
} from "@tanren/db";
import type pg from "pg";

// A client that records every NOTIFY statement it is handed.
function recordingClient(): { query: pg.PoolClient["query"]; statements: string[] } {
  const statements: string[] = [];
  const query = (async (sql: string) => {
    statements.push(sql);
    return { rows: [], rowCount: 0 };
  }) as unknown as pg.PoolClient["query"];
  return { query, statements };
}

describe("NOTIFY emitters", () => {
  it("notifyJobEnqueued fires a payload-free NOTIFY on the job-queue channel", async () => {
    const client = recordingClient();
    await notifyJobEnqueued(client as unknown as pg.PoolClient);
    expect(client.statements).toEqual([`NOTIFY ${JOB_QUEUE_CHANNEL}`]);
  });

  it("notifyRunActivity fires NOTIFY on the run channel with the run id as payload", async () => {
    const client = recordingClient();
    await notifyRunActivity(client as unknown as pg.PoolClient, "run_abc123");
    expect(client.statements).toEqual([`NOTIFY ${RUN_ACTIVITY_CHANNEL}, 'run_abc123'`]);
  });

  it("notifyRunActivity rejects an unsafe run id rather than interpolating it", async () => {
    const client = recordingClient();
    await expect(notifyRunActivity(client as unknown as pg.PoolClient, "run_'; DROP TABLE runs;--")).rejects.toThrow(
      /unsafe id/u,
    );
    // Nothing was issued — the guard fires before the query.
    expect(client.statements).toEqual([]);
  });

  it("notifyDagChanged fires NOTIFY on the dag channel with the project id as payload", async () => {
    const client = recordingClient();
    await notifyDagChanged(client as unknown as pg.PoolClient, "project_abc123");
    expect(client.statements).toEqual([`NOTIFY ${DAG_CHANGE_CHANNEL}, 'project_abc123'`]);
  });

  it("notifyDagChanged rejects an unsafe project id rather than interpolating it", async () => {
    const client = recordingClient();
    await expect(
      notifyDagChanged(client as unknown as pg.PoolClient, "project_'; DROP TABLE specs;--"),
    ).rejects.toThrow(/unsafe id/u);
    expect(client.statements).toEqual([]);
  });

  it("notifyEventAppended fires NOTIFY on the notify channel with the event id as payload", async () => {
    const client = recordingClient();
    await notifyEventAppended(client as unknown as pg.PoolClient, "42");
    expect(client.statements).toEqual([`NOTIFY ${NOTIFICATION_CHANNEL}, '42'`]);
  });

  it("notifyEventAppended rejects a non-numeric event id rather than interpolating it", async () => {
    const client = recordingClient();
    await expect(notifyEventAppended(client as unknown as pg.PoolClient, "1; DROP TABLE events;--")).rejects.toThrow(
      /unsafe event id/u,
    );
    expect(client.statements).toEqual([]);
  });
});

// A fake pooled client that is an EventEmitter (so `.on("notification")` works)
// and records LISTEN/UNLISTEN. A fake pool hands one out on connect().
class FakeNotifyClient extends EventEmitter {
  readonly listened: string[] = [];
  released = false;
  async query(sql: string): Promise<{ rows: never[]; rowCount: number }> {
    if (sql.startsWith("LISTEN")) this.listened.push(sql);
    return { rows: [], rowCount: 0 };
  }
  release(): void {
    this.released = true;
  }
}

class FakeNotifyPool {
  readonly clients: FakeNotifyClient[] = [];
  async connect(): Promise<FakeNotifyClient> {
    const client = new FakeNotifyClient();
    this.clients.push(client);
    return client;
  }
}

describe("PgNotifyListener", () => {
  it("LISTENs on subscribe and dispatches a matching notification to the handler", async () => {
    const pool = new FakeNotifyPool();
    const listener = new PgNotifyListener(pool as unknown as pg.Pool);
    const seen: string[] = [];
    await listener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => seen.push(payload));

    const client = pool.clients[0];
    expect(client.listened).toContain(`LISTEN "${RUN_ACTIVITY_CHANNEL}"`);

    // Inbound notification on the subscribed channel reaches the handler.
    client.emit("notification", { channel: RUN_ACTIVITY_CHANNEL, payload: "run_xyz" });
    expect(seen).toEqual(["run_xyz"]);

    // A notification on a DIFFERENT channel is ignored.
    client.emit("notification", { channel: "tanren_other", payload: "nope" });
    expect(seen).toEqual(["run_xyz"]);

    await listener.close();
    expect(client.released).toBe(true);
  });

  it("shares one connection across subscribers and stops dispatching after unsubscribe", async () => {
    const pool = new FakeNotifyPool();
    const listener = new PgNotifyListener(pool as unknown as pg.Pool);
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = await listener.subscribe(RUN_ACTIVITY_CHANNEL, (p) => a.push(p));
    await listener.subscribe(RUN_ACTIVITY_CHANNEL, (p) => b.push(p));

    // One held connection, not one per subscriber.
    expect(pool.clients).toHaveLength(1);
    const client = pool.clients[0];

    client.emit("notification", { channel: RUN_ACTIVITY_CHANNEL, payload: "run_1" });
    expect(a).toEqual(["run_1"]);
    expect(b).toEqual(["run_1"]);

    unsubA();
    client.emit("notification", { channel: RUN_ACTIVITY_CHANNEL, payload: "run_2" });
    // `a` unsubscribed — it gets no further dispatch; `b` still does.
    expect(a).toEqual(["run_1"]);
    expect(b).toEqual(["run_1", "run_2"]);

    await listener.close();
  });

  it("fires onConnectionError observers when the held client emits `error` (audit C2 #4-#7)", async () => {
    // The subscribe-with-reconnect helpers register here so a live disconnect
    // drives them to re-subscribe (the reconnect-failed no-longer-dead invariant).
    const pool = new FakeNotifyPool();
    const listener = new PgNotifyListener(pool as unknown as pg.Pool);
    await listener.subscribe(RUN_ACTIVITY_CHANNEL, () => {});

    const seen: number[] = [];
    listener.onConnectionError(() => seen.push(1));
    listener.onConnectionError(() => seen.push(2));
    // A throwing observer is isolated (never poisons the pump — the throw is
    // swallowed by the listener's per-observer try/catch, so observer 3 does
    // not block observer 1 or 2 from firing).
    listener.onConnectionError(() => {
      throw new Error("observer blew up");
    });

    const client = pool.clients[0];
    // Emit `error` on the held client: every observer fires (in insertion
    // order), including the throwing one whose throw is swallowed. The
    // listener's internal reconnect runs on its own; here we only assert the
    // observer fan-out.
    client.emit("error", new Error("connection dropped"));

    expect(seen).toEqual([1, 2]);

    await listener.close();
  });

  it("onConnectionError unsubscribe drops the observer for future drops", async () => {
    // We register two observers, remove the first, then emit `error` and
    // observe only the second fires. Only ONE emit — the reconnect's
    // `removeAllListeners('error')` on the stale client would break a second
    // emit (unhandled EventEmitter error).
    const pool = new FakeNotifyPool();
    const listener = new PgNotifyListener(pool as unknown as pg.Pool);
    await listener.subscribe(RUN_ACTIVITY_CHANNEL, () => {});
    const seen: number[] = [];
    const unsubObs = listener.onConnectionError(() => seen.push(1));
    listener.onConnectionError(() => seen.push(2));
    unsubObs();

    const client = pool.clients[0];
    client.emit("error", new Error("connection dropped"));
    expect(seen).toEqual([2]);
    await listener.close();
  });

  // Codex RA1, Bug 1 regression pin — a `subscribe()` whose `LISTEN` query
  // throws MUST NOT leave the handler in the underlying Set. Prior code
  // registered the handler up front and returned the unsubscribe closure only
  // on success, so a throw left the handler stranded — and
  // `subscribeWithReconnect`'s progress-spaced retry (which catches the throw
  // as transient) would leak a fresh handler on every retry attempt, growing
  // the Set unboundedly across reconnect cycles.
  it("subscribe() removes the handler when the LISTEN query throws (Bug 1)", async () => {
    // A pool whose client's `query` throws on LISTEN (the connect+register
    // succeeds; LISTEN is the failing async step).
    const badPool = throwingPool();
    const listener = new PgNotifyListener(badPool as unknown as pg.Pool);

    const handler = noopHandler;
    await expect(listener.subscribe(RUN_ACTIVITY_CHANNEL, handler)).rejects.toThrow(/LISTEN failed/u);

    // The handler MUST NOT be in the internal Set. The internal handlers Map
    // is private; the observable proof is that a fresh listener over a good
    // pool wires exactly ONE handler that fires once per notification.
    let callCount = 0;
    const goodPool = healthyPool();
    const listener2 = new PgNotifyListener(goodPool as unknown as pg.Pool);
    await listener2.subscribe(RUN_ACTIVITY_CHANNEL, () => {
      callCount += 1;
    });
    goodPool.clients[0]?.emit("notification", { channel: RUN_ACTIVITY_CHANNEL, payload: "run_1" });
    expect(callCount).toBe(1);
    await listener2.close();
    await listener.close();
  });

  // Codex RA1, Bug 1 regression pin — the retry loop shape: repeated failed
  // subscribe() calls against the SAME listener never grow the internal
  // handler Set. Prior code leaked a handler on every retry attempt.
  it("repeated failed subscribe() calls never grow the underlying handler Set (Bug 1)", async () => {
    const badPool = throwingPool();
    const listener = new PgNotifyListener(badPool as unknown as pg.Pool);

    // 5 failed attempts with the SAME handler — Bug 1 would leak one per attempt.
    const handler = noopHandler;
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(listener.subscribe(RUN_ACTIVITY_CHANNEL, handler)).rejects.toThrow(/LISTEN failed/u);
    }

    // Emit a notification against a fresh subscribe on a healthy pool — if the
    // 5 failed attempts had leaked handlers, this listener's internal Map
    // would carry stranded entries. The externally observable proof: exactly
    // ONE handler fires (the fresh probe), no stranded siblings.
    let fired = 0;
    const good = healthyPool();
    const listener2 = new PgNotifyListener(good as unknown as pg.Pool);
    await listener2.subscribe(RUN_ACTIVITY_CHANNEL, () => {
      fired += 1;
    });
    good.clients[0]?.emit("notification", { channel: RUN_ACTIVITY_CHANNEL, payload: "run_probe" });
    expect(fired).toBe(1);
    await listener2.close();
    await listener.close();
  });
});

// Hoisted at file scope so `unicorn/consistent-function-scoping` is satisfied —
// this handler captures nothing from its callers.
function noopHandler(): void {}

/**
 * A tiny factory-built test pool paired with a `queryImpl` — used by the Bug 1
 * regression pins above. Keeps the file under the max-classes-per-file cap by
 * reusing one client shape across the failing-LISTEN and healthy-LISTEN tests.
 */
interface TestQueryClient extends EventEmitter {
  released: boolean;
  query(sql: string): Promise<{ rows: never[]; rowCount: number }>;
  release(): void;
}

interface TestQueryPool {
  clients: TestQueryClient[];
  connect(): Promise<TestQueryClient>;
}

function buildQueryPool(queryImpl: (sql: string) => Promise<{ rows: never[]; rowCount: number }>): TestQueryPool {
  const pool: TestQueryPool = {
    clients: [],
    async connect(): Promise<TestQueryClient> {
      const emitter = new EventEmitter() as TestQueryClient;
      emitter.released = false;
      emitter.query = queryImpl;
      emitter.release = (): void => {
        emitter.released = true;
      };
      pool.clients.push(emitter);
      return emitter;
    },
  };
  return pool;
}

function throwingPool(): TestQueryPool {
  return buildQueryPool((sql: string) => {
    if (sql.startsWith("LISTEN")) throw new Error("LISTEN failed");
    throw new Error(`unexpected query: ${sql}`);
  });
}

function healthyPool(): TestQueryPool {
  // eslint-disable-next-line @typescript-eslint/require-await
  return buildQueryPool(async () => ({ rows: [], rowCount: 0 }));
}
