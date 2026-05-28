import { describe, expect, it } from "vitest";
import { SlackChannel } from "../src/engine/notifications/channels/slack.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// P3-0024 Slack channel tests. Uses an injected fetch double + an in-memory
// secret store so dispatch is asserted without a real webhook.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "slack",
    destination: overrides.destination ?? "credential/slack/alerts",
    label: "slack alerts",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

const failingFetch: typeof fetch = async () =>
  new Response("invalid_payload", { status: 400, statusText: "Bad Request" });

class MemorySecrets implements SecretStore {
  constructor(private readonly map: Record<string, string>) {}
  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.map[ref];
    return value === undefined ? undefined : { value };
  }
}

describe("SlackChannel", () => {
  it("resolves a credential ref to the webhook URL and POSTs the message", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const secrets = new MemorySecrets({
      "credential/slack/alerts": "https://hooks.slack.com/services/T/B/secret"
    });
    const channel = new SlackChannel({ fetch: fakeFetch, secrets });
    await channel.publish(target(), {
      title: "[FAIL] run.failed",
      body: "run failed details",
      severity: "fail",
      eventName: "run.failed",
      tags: ["tanren", "severity:fail"]
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://hooks.slack.com/services/T/B/secret");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body as string) as {
      text: string;
      blocks: Array<Record<string, unknown>>;
    };
    expect(body.text).toContain("[FAIL] run.failed");
    expect(body.text).toContain(":rotating_light:");
    const serialized = JSON.stringify(body.blocks);
    expect(serialized).toContain("run failed details");
    expect(serialized).toContain("run.failed");
  });

  it("uses a full webhook URL destination verbatim without a secret store", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("ok", { status: 200 });
    };
    const channel = new SlackChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://hooks.slack.com/services/X" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started"
    });
    expect(capturedUrl).toBe("https://hooks.slack.com/services/X");
  });

  it("adds a view-run button when payload.url is set", async () => {
    let captured: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = init as RequestInit;
      return new Response("ok", { status: 200 });
    };
    const channel = new SlackChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://hooks.slack.com/x" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.completed",
      url: "https://tanren.example/runs/run_1"
    });
    const body = JSON.parse(captured!.body as string) as { blocks: unknown[] };
    expect(JSON.stringify(body.blocks)).toContain("https://tanren.example/runs/run_1");
  });

  it("throws when Slack returns a non-2xx status", async () => {
    const channel = new SlackChannel({ fetch: failingFetch });
    await expect(
      channel.publish(target({ destination: "https://hooks.slack.com/x" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started"
      })
    ).rejects.toThrow(/slack publish failed: 400/);
  });

  it("throws when a credential ref cannot be resolved", async () => {
    const channel = new SlackChannel({ secrets: new MemorySecrets({}) });
    await expect(
      channel.publish(target({ destination: "credential/slack/missing" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started"
      })
    ).rejects.toThrow(/missing Slack webhook credential ref/);
  });
});
