// Tests for the dispatcher's code-level DEFAULT ROUTE — the "never silently
// drop a genuine escalation" guarantee. They prove: a fail-severity event with
// NO configured org route lands on the default channel when one is wired; a
// fail-severity event with NO route AND no default emits a LOUD log (never a
// silent drop); and a routine low-severity event below the default's warn floor
// notifies no one (no spam).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  NotificationDispatcher,
  type ChannelKind,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationTargetRow,
} from "../src/engine/notifications/index.js";
import { buildChannelRegistry } from "../src/engine/notifications/registry.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";

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

function baseRegistry(ntfy: NotificationChannel): Record<ChannelKind, NotificationChannel> {
  return { ...buildChannelRegistry({}), ntfy };
}

describe("NotificationDispatcher default route", () => {
  it("falls back to the code-level default route for a fail-severity event with NO configured route", async () => {
    const client = new NotificationMemoryClient();
    // No targets, no routes seeded — the matrix matches nothing.
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry(ntfy),
      now: () => new Date("2026-01-05T12:00:00Z"),
      defaultRoute: { channelKind: "ntfy", destination: "tanren-escalations" },
    });

    await dispatcher.onEvent(
      {
        eventType: "dag.spec.needs_attention",
        payload: { source: "strand", specId: "spec_1", reason: "no_live_run", terminalRuns: [], attempts: 3 },
      },
      { orgId: "org_1", actorUserId: null, specId: "spec_1", projectId: "project_1" },
    );

    // The escalation LANDED via the default route — never a silent drop.
    expect(ntfy.calls).toHaveLength(1);
    expect(ntfy.calls[0]?.target.destination).toBe("tanren-escalations");
    expect(ntfy.calls[0]?.payload.severity).toBe("fail");
    expect(client.dispatches[0]?.status).toBe("sent");
    const logPayload = client.dispatches[0]?.payload as { layering?: string } | undefined;
    expect(logPayload?.layering).toBe("default_route");
  });

  it("LOUD-logs (never silently drops) a fail-severity event when no route AND no default route", async () => {
    const client = new NotificationMemoryClient();
    const ntfy = new CapturingChannel("ntfy");
    const logs: Array<{ level: string; message: string }> = [];
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry(ntfy),
      now: () => new Date("2026-01-05T12:00:00Z"),
      log: (level, message) => logs.push({ level, message }),
      // No defaultRoute configured.
    });

    await dispatcher.onEvent(
      {
        eventType: "dag.spec.needs_attention",
        payload: { source: "strand", specId: "spec_1", reason: "no_live_run", terminalRuns: [], attempts: 3 },
      },
      { orgId: "org_1", actorUserId: null, specId: "spec_1" },
    );

    // Nothing delivered (no route, no default) — but it was NOT silent.
    expect(ntfy.calls).toHaveLength(0);
    expect(client.dispatches).toHaveLength(0);
    const loud = logs.find((l) => l.message.includes("no notification route configured for a fail-severity event"));
    expect(loud).toBeDefined();
    expect(loud?.level).toBe("error");
  });

  it("does NOT route a routine low-severity event via the default (no spam)", async () => {
    const client = new NotificationMemoryClient();
    const ntfy = new CapturingChannel("ntfy");
    const logs: Array<{ level: string; message: string }> = [];
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry(ntfy),
      now: () => new Date("2026-01-05T12:00:00Z"),
      log: (level, message) => logs.push({ level, message }),
      // A default route IS configured — but its warn floor masks routine events.
      defaultRoute: { channelKind: "ntfy", destination: "tanren-escalations" },
    });

    // `task.started` is an `info`-severity routine lifecycle event (below the
    // default route's `warn` floor) with no configured route.
    await dispatcher.onEvent(
      { eventType: "task.started", payload: { taskKind: "plan" } },
      { orgId: "org_1", actorUserId: null, runId: "run_1" },
    );

    expect(ntfy.calls).toHaveLength(0);
    expect(client.dispatches).toHaveLength(0);
    // And no loud "fail-severity with no route" log either — it is routine.
    expect(logs).toHaveLength(0);
  });
});
