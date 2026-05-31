import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { TypedEvent } from "../src/engine/events/index.js";
import {
  NotificationDispatcher,
  NotificationRouteStore,
  NotificationTargetStore,
  type ChannelKind,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationTargetRow,
} from "../src/engine/notifications/index.js";
import { effectiveSeverityFor } from "../src/engine/notifications/dispatcher.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";
import type { ChannelRegistryDeps } from "../src/engine/notifications/registry.js";
import { buildChannelRegistry } from "../src/engine/notifications/registry.js";

// P2A-0017 dispatcher tests: end-to-end matrix evaluation + redaction +
// channel publish + dispatch log. No real network; channels are either
// stubs or a test-double NtfyChannel via the injected `fetch`.

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

describe("NotificationDispatcher", () => {
  it("publishes to a wired channel and records the dispatch", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });

    const ntfy = new CapturingChannel("ntfy");
    const channels = baseRegistry({ ntfy });
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels,
      // Monday
      now: () => new Date("2026-01-05T12:00:00Z"),
    });

    const event: TypedEvent = {
      eventType: "run.failed",
      payload: { status: "failed", message: "broken" },
    };

    await dispatcher.onEvent(event, {
      orgId: "org_1",
      actorUserId: null,
      projectId: "project_1",
      runId: "run_1",
      specId: "spec_1",
    });

    expect(ntfy.calls).toHaveLength(1);
    expect(ntfy.calls[0]?.payload.severity).toBe("fail");
    expect(ntfy.calls[0]?.payload.title).toContain("run.failed");
    expect(client.dispatches).toHaveLength(1);
    expect(client.dispatches[0]?.status).toBe("sent");
    expect(client.dispatches[0]?.channel).toBe("ntfy");
  });

  it("respects the route's minSeverity floor", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, {
      id: "r_ntfy",
      targetId: "target_ntfy",
      eventName: "run.started",
      minSeverity: "warn",
    });

    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });

    await dispatcher.onEvent(
      { eventType: "run.started", payload: { status: "running" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(ntfy.calls).toHaveLength(0);
    expect(client.dispatches).toHaveLength(0);
  });

  it("skips and logs when weekendMute fires on a weekend", async () => {
    const client = new NotificationMemoryClient();
    const created = await seedOrgTarget(client, "ntfy");
    expect(created.weekendMute).toBe(false);
    // Mutate the stored row to weekendMute=true (the memory client stores
    // raw integers).
    (client.targets.get("target_ntfy") as Record<string, unknown>).weekend_mute = 1;
    await seedRoute(client, { id: "r_ntfy", targetId: "target_ntfy", eventName: "run.failed" });

    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      // Saturday
      now: () => new Date("2026-01-03T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(ntfy.calls).toHaveLength(0);
    const log = client.dispatches[0];
    expect(log).toBeDefined();
    expect(log?.status).toBe("skipped");
    const logPayload = log?.payload as { reason: string } | undefined;
    expect(logPayload?.reason).toBe("weekend_mute");
  });

  it("records stubbed delivery for unwired channels", async () => {
    const client = new NotificationMemoryClient();
    // `teams` is still unwired (only ntfy/slack/github_checks are wired).
    await seedOrgTarget(client, "teams");
    await seedRoute(client, { id: "r_teams", targetId: "target_teams", eventName: "run.failed" });

    const channels = baseRegistry();
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels,
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(client.dispatches[0]?.status).toBe("stubbed");
    expect(client.dispatches[0]?.channel).toBe("teams");
  });

  it("routes an event to the wired slack channel", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "slack");
    await seedRoute(client, { id: "r_slack", targetId: "target_slack", eventName: "run.failed" });

    const slack = new CapturingChannel("slack");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ slack }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(slack.calls).toHaveLength(1);
    expect(client.dispatches[0]?.status).toBe("sent");
    expect(client.dispatches[0]?.channel).toBe("slack");
  });

  it("routes an event to the wired github_checks channel", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "github_checks");
    await seedRoute(client, {
      id: "r_gh",
      targetId: "target_github_checks",
      eventName: "run.failed",
    });

    const github = new CapturingChannel("github_checks");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ github_checks: github }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });
    await dispatcher.onEvent(
      { eventType: "run.failed", payload: { status: "failed", message: "x" } },
      { orgId: "org_1", actorUserId: null },
    );
    expect(github.calls).toHaveLength(1);
    expect(client.dispatches[0]?.status).toBe("sent");
    expect(client.dispatches[0]?.channel).toBe("github_checks");
  });

  it.each(["teams", "discord", "email", "twilio", "pagerduty", "webhook"] as const)(
    "routes an event to the wired %s channel",
    async (kind) => {
      const client = new NotificationMemoryClient();
      await seedOrgTarget(client, kind);
      await seedRoute(client, {
        id: `r_${kind}`,
        targetId: `target_${kind}`,
        eventName: "run.failed",
      });

      const channel = new CapturingChannel(kind);
      const dispatcher = new NotificationDispatcher({
        query: client as unknown as pg.Pool,
        channels: baseRegistry({ [kind]: channel }),
        now: () => new Date("2026-01-05T12:00:00Z"),
      });
      await dispatcher.onEvent(
        { eventType: "run.failed", payload: { status: "failed", message: "x" } },
        { orgId: "org_1", actorUserId: null },
      );
      expect(channel.calls).toHaveLength(1);
      expect(client.dispatches[0]?.status).toBe("sent");
      expect(client.dispatches[0]?.channel).toBe(kind);
    },
  );

  it("records failed when a wired channel throws and does not propagate", async () => {
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
    await expect(
      dispatcher.onEvent(
        { eventType: "run.failed", payload: { status: "failed", message: "x" } },
        { orgId: "org_1", actorUserId: null },
      ),
    ).resolves.toBeUndefined();
    expect(client.dispatches[0]?.status).toBe("failed");
  });

  it("redacts payload fields before handing them to the channel", async () => {
    const client = new NotificationMemoryClient();
    await seedOrgTarget(client, "ntfy");
    await seedRoute(client, {
      id: "r_ntfy",
      targetId: "target_ntfy",
      eventName: "writer.completed",
    });

    const ntfy = new CapturingChannel("ntfy");
    const dispatcher = new NotificationDispatcher({
      query: client as unknown as pg.Pool,
      channels: baseRegistry({ ntfy }),
      now: () => new Date("2026-01-05T12:00:00Z"),
    });

    const event: TypedEvent = {
      eventType: "writer.completed",
      payload: {
        diff: "raw secret diff payload",
        intent: "happy intent",
        commits: [],
        exitReason: "ok",
        tokenUsage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2,
        },
        telemetry: {
          rawEventCount: 0,
          tokenUsage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
          },
        },
        decisions: [],
        toolCalls: [
          {
            name: "shell",
            args: { command: "echo $SECRET" },
            outputSummary: "ran",
          },
        ],
        diffBytes: 12,
        commitSha: "abc",
      },
    };

    await dispatcher.onEvent(event, { orgId: "org_1", actorUserId: null });

    const body = ntfy.calls[0]?.payload.body ?? "";
    // diff is `redacted` per sensitivity rules — body must not include the
    // raw string and must include the redaction marker.
    expect(body).not.toContain("raw secret diff payload");
    expect(body).toContain("__redacted");
    // intent is `public` — present in the redacted output.
    expect(body).toContain("happy intent");
  });

  it("skips entirely when the org has no targets configured", async () => {
    const client = new NotificationMemoryClient();
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
    expect(ntfy.calls).toHaveLength(0);
    expect(client.dispatches).toHaveLength(0);
  });
});

describe("effectiveSeverityFor", () => {
  it("promotes checker.verdict to warn when passed=false", () => {
    const sev = effectiveSeverityFor({
      eventType: "checker.verdict",
      payload: { runId: "r", taskId: "t", subtaskIndex: 0, passed: false, reasoning: "no" },
    });
    expect(sev).toBe("warn");
  });

  it("renders checker.verdict as ok when passed=true", () => {
    const sev = effectiveSeverityFor({
      eventType: "checker.verdict",
      payload: { runId: "r", taskId: "t", subtaskIndex: 0, passed: true, reasoning: "yes" },
    });
    expect(sev).toBe("ok");
  });

  it("uses the registry default for non-verdict events", () => {
    expect(effectiveSeverityFor({ eventType: "run.completed", payload: { status: "succeeded" } })).toBe("ok");
    expect(
      effectiveSeverityFor({
        eventType: "cost.unattributable",
        payload: { taskId: "t", cli: "codex", authRef: "x", reason: "x" },
      }),
    ).toBe("fail");
  });

  it("promotes auditor.verdict to warn when passed=false and ok when passed=true", () => {
    expect(
      effectiveSeverityFor({
        eventType: "auditor.verdict",
        payload: { runId: "r", taskId: "t", subtaskIndex: 0, passed: false, reasoning: "no" },
      }),
    ).toBe("warn");
    expect(
      effectiveSeverityFor({
        eventType: "auditor.verdict",
        payload: { runId: "r", taskId: "t", subtaskIndex: 0, passed: true, reasoning: "ok" },
      }),
    ).toBe("ok");
  });

  it("does not promote run.completed when the outcome lacks 'fail'", () => {
    expect(
      effectiveSeverityFor({ eventType: "run.completed", payload: { status: "succeeded", outcome: "merged" } }),
    ).toBe("ok");
  });

  it("promotes run.completed (ok base) one tier to info when the outcome contains 'fail'", () => {
    expect(
      effectiveSeverityFor({ eventType: "run.completed", payload: { status: "succeeded", outcome: "ci-fail" } }),
    ).toBe("info");
  });
});

function baseRegistry(
  overrides: Partial<Record<ChannelKind, NotificationChannel>> = {},
): Record<ChannelKind, NotificationChannel> {
  const base = buildChannelRegistry({} satisfies ChannelRegistryDeps);
  // Default: replace the real NtfyChannel with a stubbed-but-wired
  // capturing channel so tests don't accidentally hit the network. Tests
  // that exercise stub behavior supply a `slack` override etc.
  const baseWithSafeNtfy: Record<ChannelKind, NotificationChannel> = {
    ...base,
    ntfy: overrides.ntfy ?? new CapturingChannel("ntfy"),
  };
  return { ...baseWithSafeNtfy, ...overrides };
}
