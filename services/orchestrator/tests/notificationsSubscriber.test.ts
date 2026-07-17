// Tests for the NotificationSubscriber — the production wiring that makes
// notifications actually reach a human. Over a fake PgNotifyListener + a fake
// pool that returns one events row, they prove the EVENT-DRIVEN path end-to-end:
//   - an appended `dag.spec.needs_attention` (project-scoped, NO run id, so it
//     fires NO `tanren_run` wake) reaches a CONFIGURED channel via the real
//     dispatcher + the channel registry — the gap this PR closes;
//   - the subscriber reads the event by id under the system scope and decodes it;
//   - stop() unsubscribes and a dispatch failure never throws into the notify pump.

import { NOTIFICATION_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  NotificationDispatcher,
  NotificationRouteStore,
  NotificationTargetStore,
  type ChannelKind,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationTargetRow,
} from "../src/engine/notifications/index.js";
import { buildChannelRegistry } from "../src/engine/notifications/registry.js";
import { NotificationSubscriber } from "../src/engine/notifications/subscriber.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";

class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
  private connErrObs = new Set<() => void>();
  unsubscribeCount = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      this.unsubscribeCount += 1;
      set?.delete(handler);
    };
  }
  // The subscribeWithReconnect helper registers here so a live drop drives re-subscribe.
  onConnectionError(cb: () => void): () => void {
    this.connErrObs.add(cb);
    return () => this.connErrObs.delete(cb);
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

/** Inserts an event after subscribe starts but before it resolves / LISTEN is live. */
class CommitDuringSubscribeListener extends FakeNotifyListener {
  constructor(private readonly beforeSubscribeResolves: () => void) {
    super();
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    this.beforeSubscribeResolves();
    return super.subscribe(channel, handler);
  }
}

class CapturingChannel implements NotificationChannel {
  readonly kind: ChannelKind;
  readonly wired = true;
  readonly calls: Array<{ target: NotificationTargetRow; payload: NotificationPayload }> = [];
  constructor(kind: ChannelKind) {
    this.kind = kind;
  }
  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    this.calls.push({ target, payload });
  }
}

/**
 * A fake pool whose `connect()` returns a client that answers the BEGIN/COMMIT
 * the system scope opens and the ordered `SELECT ... FROM events WHERE id >`
 * catch-up scan the subscriber issues, returning the seeded event rows.
 */
function fakeEventsPool(rows: Map<string, Record<string, unknown>>): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: unknown[] }> {
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM events")) {
        const after = BigInt(String(params[0] ?? "0"));
        const visible = [...rows.entries()]
          .filter(([id]) => BigInt(id) > after)
          .sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
          .map(([id, row]) => ({ id, ...row }));
        return { rows: visible };
      }
      // BEGIN / COMMIT / ROLLBACK / SET LOCAL.
      return { rows: [] };
    },
    release() {},
  };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
const flush = async (): Promise<void> => {
  await tick();
  await tick();
  await tick();
};

function buildDispatcher(client: NotificationMemoryClient, channel: NotificationChannel): NotificationDispatcher {
  const base = buildChannelRegistry({});
  const channels = { ...base, ntfy: new CapturingChannel("ntfy"), [channel.kind]: channel };
  return new NotificationDispatcher({
    query: client as unknown as pg.Pool,
    channels,
    now: () => new Date("2026-01-05T12:00:00Z"),
  });
}

describe("NotificationSubscriber", () => {
  it("replays an event committed before the initial LISTEN resolves", async () => {
    const dbClient = new NotificationMemoryClient();
    await NotificationTargetStore.create(dbClient, {
      id: "target_slack",
      orgId: "org_1",
      scope: "org",
      userId: null,
      channelKind: "slack",
      destination: "credential/slack-webhook",
      label: "ops slack",
      enabled: true,
      weekendMute: false,
    });
    await NotificationRouteStore.create(dbClient, {
      id: "r_slack",
      targetId: "target_slack",
      eventName: "dag.spec.needs_attention",
      enabled: true,
      minSeverity: "warn",
    });
    const events = new Map<string, Record<string, unknown>>();
    const listener = new CommitDuringSubscribeListener(() => {
      // No NOTIFY is fired for this row: it represents the exact boot window
      // in which Postgres discards a commit because LISTEN is not live yet.
      events.set("43", {
        event_type: "dag.spec.needs_attention",
        payload: {
          source: "strand",
          specId: "spec_1",
          reason: "persistent_failure",
          terminalRuns: [],
          attempts: 3,
          message: "the autonomous self-heal could not make progress; a decision is needed",
        },
        org_id: "org_1",
        run_id: null,
        spec_id: "spec_1",
        project_id: "project_1",
        user_id: null,
      });
    });
    const slack = new CapturingChannel("slack");
    const sub = new NotificationSubscriber({
      pool: fakeEventsPool(events),
      notifyListener: listener as never,
      dispatcher: buildDispatcher(dbClient, slack),
    });

    await sub.start();
    await flush();

    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.payload.eventName).toBe("dag.spec.needs_attention");
    await sub.stop();
  });

  it("an appended dag.spec.needs_attention reaches a configured channel via the registry", async () => {
    // Configure an org slack route for the escalation event (the matrix match).
    const dbClient = new NotificationMemoryClient();
    await NotificationTargetStore.create(dbClient, {
      id: "target_slack",
      orgId: "org_1",
      scope: "org",
      userId: null,
      channelKind: "slack",
      destination: "credential/slack-webhook",
      label: "ops slack",
      enabled: true,
      weekendMute: false,
    });
    await NotificationRouteStore.create(dbClient, {
      id: "r_slack",
      targetId: "target_slack",
      eventName: "dag.spec.needs_attention",
      enabled: true,
      minSeverity: "warn",
    });

    const slack = new CapturingChannel("slack");
    const dispatcher = buildDispatcher(dbClient, slack);

    // The appended event row the subscriber re-reads by id. Note: NO run_id —
    // exactly the project-scoped escalation that fires no `tanren_run` wake.
    const events = new Map<string, Record<string, unknown>>([
      [
        "42",
        {
          event_type: "dag.spec.needs_attention",
          payload: {
            source: "strand",
            specId: "spec_1",
            reason: "persistent_failure",
            terminalRuns: [],
            attempts: 3,
            message: "the autonomous self-heal could not make progress; a decision is needed",
          },
          org_id: "org_1",
          run_id: null,
          spec_id: "spec_1",
          project_id: "project_1",
          user_id: null,
        },
      ],
    ]);

    const listener = new FakeNotifyListener();
    const sub = new NotificationSubscriber({
      pool: fakeEventsPool(events),
      notifyListener: listener as never,
      dispatcher,
    });
    await sub.start();
    await flush();

    listener.fire(NOTIFICATION_CHANNEL, "42");
    await flush();

    // The escalation LANDED on the configured slack channel.
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.payload.severity).toBe("fail");
    expect(slack.calls[0]?.payload.eventName).toBe("dag.spec.needs_attention");
    expect(slack.calls[0]?.target.destination).toBe("credential/slack-webhook");
    expect(dbClient.dispatches[0]?.status).toBe("sent");
    expect(dbClient.dispatches[0]?.channel).toBe("slack");
    await sub.stop();
  });

  it("an empty payload and an unknown event id are ignored without throwing", async () => {
    const dbClient = new NotificationMemoryClient();
    const dispatcher = buildDispatcher(dbClient, new CapturingChannel("slack"));
    const listener = new FakeNotifyListener();
    const sub = new NotificationSubscriber({
      pool: fakeEventsPool(new Map()),
      notifyListener: listener as never,
      dispatcher,
    });
    await sub.start();
    await flush();

    expect(() => listener.fire(NOTIFICATION_CHANNEL, "")).not.toThrow();
    expect(() => listener.fire(NOTIFICATION_CHANNEL, "999")).not.toThrow();
    await flush();

    expect(dbClient.dispatches).toHaveLength(0);
    await sub.stop();
  });

  it("a dispatch failure is non-fatal: logged, never thrown into the notify pump", async () => {
    // A dispatcher whose onEvent rejects — the subscriber must swallow it.
    const dispatcher = {
      async onEvent(): Promise<void> {
        throw new Error("dispatcher blew up");
      },
    } as unknown as NotificationDispatcher;
    const events = new Map<string, Record<string, unknown>>([
      [
        "7",
        {
          event_type: "run.failed",
          payload: { status: "failed", message: "x" },
          org_id: "org_1",
          run_id: "run_1",
          spec_id: null,
          project_id: "project_1",
          user_id: null,
        },
      ],
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = new FakeNotifyListener();
    const sub = new NotificationSubscriber({
      pool: fakeEventsPool(events),
      notifyListener: listener as never,
      dispatcher,
    });
    await sub.start();
    await flush();

    expect(() => listener.fire(NOTIFICATION_CHANNEL, "7")).not.toThrow();
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    await sub.stop();
  });

  it("stop() unsubscribes from the notify bus", async () => {
    const dbClient = new NotificationMemoryClient();
    const dispatcher = buildDispatcher(dbClient, new CapturingChannel("slack"));
    const listener = new FakeNotifyListener();
    const sub = new NotificationSubscriber({
      pool: fakeEventsPool(new Map()),
      notifyListener: listener as never,
      dispatcher,
    });
    await sub.start();
    await flush();
    await sub.stop();
    expect(listener.unsubscribeCount).toBe(1);
  });
});
