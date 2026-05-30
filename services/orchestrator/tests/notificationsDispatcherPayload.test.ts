import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  NotificationDispatcher,
  NotificationRouteStore,
  NotificationTargetStore,
  type ChannelKind,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationTargetRow,
} from "../src/engine/notifications/index.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";
import { buildChannelRegistry } from "../src/engine/notifications/registry.js";

// Dispatcher payload-construction + dispatch-ledger tests. Splits the title/
// body builder, the urlFor threading, the recorded dispatch metadata, the
// no_adapter + throwing-stub fan-out paths, and the run.completed severity
// promotion out of notificationsDispatcher.test.ts to stay under the per-file
// line cap. Drives real outcomes through a CapturingChannel + memory client.

class CapturingChannel implements NotificationChannel {
  readonly kind: ChannelKind;
  readonly wired = true;
  readonly calls: Array<{ target: NotificationTargetRow; payload: NotificationPayload }> = [];
  private readonly thrower: boolean;

  constructor(kind: ChannelKind, opts: { throws?: boolean } = {}) {
    this.kind = kind;
    this.thrower = opts.throws ?? false;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    this.calls.push({ target, payload });
    if (this.thrower) throw new Error("simulated channel failure");
  }
}

function seedOrgTarget(client: NotificationMemoryClient, kind: ChannelKind, id = `target_${kind}`) {
  return NotificationTargetStore.create(client, {
    id,
    orgId: "org_1",
    scope: "org",
    userId: null,
    channelKind: kind,
    destination: kind === "ntfy" ? "tanren-runs" : `${kind}-dest`,
    label: `${kind} default`,
    enabled: true,
    weekendMute: false,
  });
}

async function seedRoute(
  client: NotificationMemoryClient,
  args: {
    id: string;
    targetId: string;
    eventName: string;
    minSeverity?: "ok" | "info" | "warn" | "fail";
  },
) {
  return NotificationRouteStore.create(client, {
    id: args.id,
    targetId: args.targetId,
    eventName: args.eventName,
    enabled: true,
    minSeverity: args.minSeverity ?? "info",
  });
}

function baseRegistry(
  overrides: Partial<Record<ChannelKind, NotificationChannel>> = {},
): Record<ChannelKind, NotificationChannel> {
  const base = buildChannelRegistry({});
  const baseWithSafeNtfy: Record<ChannelKind, NotificationChannel> = {
    ...base,
    ntfy: overrides.ntfy ?? new CapturingChannel("ntfy"),
  };
  return { ...baseWithSafeNtfy, ...overrides };
}

describe("NotificationDispatcher payload + ledger", () => {
  it("builds the title as [SEVERITY] eventName and the body lines from context + redacted payload", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "boom" } },
      { orgId: "org_1", actorUserId: null, projectId: "project_1", runId: "run_1", specId: "spec_1" },
    );
    const published = ntfy.calls[0]!.payload;
    expect(published.title).toBe("[FAIL] run.failed");
    const lines = published.body.split("\n");
    expect(lines[0]).toBe("project=project_1");
    expect(lines[1]).toBe("run=run_1");
    expect(lines[2]).toBe("spec=spec_1");
    expect(lines[3]).toBe("event=run.failed");
    // The last line is the serialized redacted payload.
    expect(lines[4]).toContain('"status":"failed"');
    // Tags carry the tanren + severity markers.
    expect(published.tags).toEqual(["tanren", "severity:fail"]);
  });

  it("omits context lines that are absent and still emits the event line", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    const lines = ntfy.calls[0]!.payload.body.split("\n");
    expect(lines[0]).toBe("event=run.failed");
    expect(lines.some((l) => l.startsWith("project="))).toBe(false);
    expect(lines.some((l) => l.startsWith("run="))).toBe(false);
  });

  it("caps an oversized serialized payload at 4096 chars with a trailing ellipsis", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "z".repeat(8000) } },
      { orgId: "org_1", actorUserId: null },
    );
    const serialized = ntfy.calls[0]!.payload.body.split("\n").at(-1)!;
    expect(serialized.length).toBe(4096);
    expect(serialized.endsWith("...")).toBe(true);
  });

  it("threads urlFor's result into the published payload url", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
      urlFor: (_event, ctx) => `https://tanren.example/runs/${ctx.runId}`,
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null, runId: "run_42" },
    );
    expect(ntfy.calls[0]!.payload.url).toBe("https://tanren.example/runs/run_42");
  });

  it("leaves the payload url unset when no urlFor is supplied", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(ntfy.calls[0]!.payload.url).toBeUndefined();
  });

  it("records the dispatch payload metadata (layering/severity/title) and stamps sentAt only on sent", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const ntfy = new CapturingChannel("ntfy");
    const now = new Date("2026-01-05T12:00:00Z");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => now,
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    const log = client.dispatches[0]!;
    expect(log.status).toBe("sent");
    expect(log.attempts).toBe(1);
    expect(log.sent_at).toEqual(now);
    const logPayload = log.payload as { layering: string; severity: string; title: string };
    expect(logPayload.layering).toBe("org_default");
    expect(logPayload.severity).toBe("fail");
    expect(logPayload.title).toBe("[FAIL] run.failed");
  });

  it("does not stamp sentAt when a wired channel fails", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });
    const failing = new CapturingChannel("ntfy", { throws: true });
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy: failing }),
      now: () => new Date("2026-01-05T12:00:00Z"),
      log: () => {},
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(client.dispatches[0]!.status).toBe("failed");
    expect(client.dispatches[0]!.sent_at).toBeNull();
  });

  it("logs a no_adapter skip row when the matched channelKind has no registry entry", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "discord");
    await seedRoute(client, { id: "r_d", targetId: "target_discord", eventName: "run.failed" });
    const channels = baseRegistry();
    // Drop the discord adapter so the registry has a gap for this kind.
    delete (channels as Record<string, unknown>)["discord"];
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: channels as Record<ChannelKind, NotificationChannel>,
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    const log = client.dispatches[0]!;
    expect(log.status).toBe("skipped");
    expect((log.payload as { reason: string }).reason).toBe("no_adapter");
  });

  it("does not propagate when an unwired stub channel throws and still records stubbed", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "teams");
    await seedRoute(client, { id: "r_teams", targetId: "target_teams", eventName: "run.failed" });
    const throwingStub: NotificationChannel = {
      kind: "teams",
      wired: false,
      async publish() {
        throw new Error("stub regressed");
      },
    };
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ teams: throwingStub }),
      now: () => new Date("2026-01-05T12:00:00Z"),
      log: () => {},
    });
    await expect(
      dispatcher.onEvent(
        { eventType: "run.failed", payload: { status: "failed", message: "x" } },
        { orgId: "org_1", actorUserId: null },
      ),
    ).resolves.toBeUndefined();
    expect(client.dispatches[0]!.status).toBe("stubbed");
  });

  it("promotes run.completed one tier (ok->info) when the outcome contains 'fail'", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, {
      id: "r_ntfy",
      targetId: "target_ntfy",
      eventName: "run.completed",
      minSeverity: "info",
    });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.completed", payload: { status: "succeeded", outcome: "partial-failure" } },
      { orgId: "org_1", actorUserId: null },
    );
    // run.completed defaults to ok; "fail" in outcome promotes ok->info.
    expect(ntfy.calls).toHaveLength(1);
    expect(ntfy.calls[0]!.payload.severity).toBe("info");
  });

  it("does not fire run.completed at an info floor when the outcome is clean (stays ok)", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, {
      id: "r_ntfy",
      targetId: "target_ntfy",
      eventName: "run.completed",
      minSeverity: "info",
    });
    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.completed", payload: { status: "succeeded", outcome: "merged" } },
      { orgId: "org_1", actorUserId: null },
    );
    // ok severity is below the info floor, so nothing fires.
    expect(ntfy.calls).toHaveLength(0);
  });
});
