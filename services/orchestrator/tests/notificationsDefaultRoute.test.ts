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
        payload: {
          source: "strand",
          specId: "spec_1",
          reason: "persistent_failure",
          terminalRuns: [],
          attempts: 3,
          message: "the autonomous self-heal could not make progress; a decision is needed",
        },
      },
      { orgId: "org_1", actorUserId: null, specId: "spec_1", projectId: "project_1" },
    );

    // The escalation LANDED via the default route — never a silent drop.
    expect(ntfy.calls).toHaveLength(1);
    expect(ntfy.calls[0]?.target.destination).toBe("tanren-escalations");
    expect(ntfy.calls[0]?.payload.severity).toBe("fail");
    expect(client.dispatches[0]?.status).toBe("sent");
    expect(client.dispatches[0]?.tenant_id).toBe("org_1");
    const logPayload = client.dispatches[0]?.payload as { layering?: string } | undefined;
    expect(logPayload?.layering).toBe("default_route");
  });

  it("routes BOTH needs_attention sources (strand AND merge_conflict) at fail severity — no source-specific gap", async () => {
    // The escalation event is a discriminated union on `source`; the dispatcher routes
    // on event name + severity (source-agnostic), so BOTH the strand-reconciler
    // escalation and the merge-conflict escalation must clear the default route's floor
    // and land. Pins that closing PR4 leaves no default-route gap for the strand source.
    for (const payload of [
      {
        source: "strand" as const,
        specId: "spec_1",
        reason: "persistent_failure" as const,
        terminalRuns: [],
        attempts: 3,
        message: "the autonomous self-heal could not make progress; a decision is needed",
      },
      {
        source: "merge_conflict" as const,
        specId: "spec_1",
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
        message: "the resolver judged these specs' intents genuinely conflict",
      },
    ]) {
      const client = new NotificationMemoryClient();
      const ntfy = new CapturingChannel("ntfy");
      const dispatcher = new NotificationDispatcher({
        query: client as unknown as pg.Pool,
        channels: baseRegistry(ntfy),
        now: () => new Date("2026-01-05T12:00:00Z"),
        defaultRoute: { channelKind: "ntfy", destination: "tanren-escalations" },
      });

      await dispatcher.onEvent(
        { eventType: "dag.spec.needs_attention", payload },
        { orgId: "org_1", actorUserId: null, specId: "spec_1", projectId: "project_1" },
      );

      expect(ntfy.calls).toHaveLength(1);
      expect(ntfy.calls[0]?.payload.severity).toBe("fail");
      expect(ntfy.calls[0]?.target.destination).toBe("tanren-escalations");
    }
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
        payload: {
          source: "strand",
          specId: "spec_1",
          reason: "persistent_failure",
          terminalRuns: [],
          attempts: 3,
          message: "the autonomous self-heal could not make progress; a decision is needed",
        },
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

  it("routes deploy.verified (live-URL-up milestone) via the default channel BY DEFAULT", async () => {
    // The milestone-notifications chain: a deploy proven live must reach a human
    // without any per-event route config. `deploy.verified` is `warn` (it clears the
    // default route's warn floor), so on an org with NO configured route it still
    // lands on the code-level default channel.
    const client = new NotificationMemoryClient();
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry(ntfy),
      now: () => new Date("2026-01-05T12:00:00Z"),
      defaultRoute: { channelKind: "ntfy", destination: "tanren-milestones" },
    });

    await dispatcher.onEvent(
      {
        eventType: "deploy.verified",
        payload: {
          provider: "deploy.vercel",
          appId: "app_1",
          deploymentId: "dpl_1",
          url: "https://apex-url-shortener.example.app",
          state: "READY",
          smokeStatus: 200,
        },
      },
      { orgId: "org_1", actorUserId: null, runId: "run_1", projectId: "project_1" },
    );

    // The live-URL milestone LANDED via the default route — no manual route needed.
    expect(ntfy.calls).toHaveLength(1);
    expect(ntfy.calls[0]?.target.destination).toBe("tanren-milestones");
    expect(ntfy.calls[0]?.payload.severity).toBe("warn");
    expect(client.dispatches[0]?.status).toBe("sent");
    const logPayload = client.dispatches[0]?.payload as { layering?: string } | undefined;
    expect(logPayload?.layering).toBe("default_route");
  });

  it("routes a budget milestone (50% / 80% of ceiling) via the default channel BY DEFAULT", async () => {
    // The other milestone-notifications signal: cumulative spend crossed a budget
    // fraction. `dag.budget.milestone` is `warn`, so it clears the default route's
    // floor and reaches the org's channel without per-event route config.
    const client = new NotificationMemoryClient();
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry(ntfy),
      now: () => new Date("2026-01-05T12:00:00Z"),
      defaultRoute: { channelKind: "ntfy", destination: "tanren-milestones" },
    });

    await dispatcher.onEvent(
      {
        eventType: "dag.budget.milestone",
        payload: { band: 80, ceilingUsd: 50, spentUsd: 41.2, period: "total" },
      },
      { orgId: "org_1", actorUserId: null, projectId: "project_1" },
    );

    expect(ntfy.calls).toHaveLength(1);
    expect(ntfy.calls[0]?.target.destination).toBe("tanren-milestones");
    expect(ntfy.calls[0]?.payload.severity).toBe("warn");
    expect(client.dispatches[0]?.status).toBe("sent");
  });

  it("LOUD-logs a budget milestone when no route AND no default channel (never a silent drop)", async () => {
    // The doctrine: a REQUIRED-but-missing channel must fail loud. A budget milestone
    // on an org with NO configured route AND no code-level default emits a LOUD log
    // rather than silently swallowing the heads-up.
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
        eventType: "dag.budget.milestone",
        payload: { band: 50, ceilingUsd: 50, spentUsd: 26, period: "total" },
      },
      { orgId: "org_1", actorUserId: null, projectId: "project_1" },
    );

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
