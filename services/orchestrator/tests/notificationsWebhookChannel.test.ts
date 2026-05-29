import { describe, expect, it } from "vitest";
import { WebhookChannel } from "../src/engine/notifications/channels/webhook.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Generic webhook channel tests. Injected fetch double + in-memory secrets.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "webhook",
    destination: overrides.destination ?? "credential/webhook/alerts",
    label: "webhook alerts",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const failingFetch: typeof fetch = async () => new Response("bad", { status: 500, statusText: "Server Error" });

class MemorySecrets implements SecretStore {
  constructor(private readonly map: Record<string, string>) {}
  async put(): Promise<void> {}
  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.map[ref];
    return value === undefined ? undefined : { ref, value };
  }
  async delete(): Promise<void> {}
}

describe("WebhookChannel", () => {
  it("resolves a credential ref and POSTs the raw payload shape", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const secrets = new MemorySecrets({
      "credential/webhook/alerts": "https://hooks.example.com/ingest",
    });
    const channel = new WebhookChannel({ fetch: fakeFetch, secrets });
    await channel.publish(target(), {
      title: "run failed",
      body: "details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
      tags: ["tanren"],
    });
    expect(captured!.url).toBe("https://hooks.example.com/ingest");
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      title: "run failed",
      body: "details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
      tags: ["tanren"],
    });
  });

  it("uses a full URL destination verbatim and omits optional fields", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const channel = new WebhookChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://hooks.example.com/x" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(captured!.url).toBe("https://hooks.example.com/x");
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("tags");
  });

  it("throws when the endpoint returns a non-2xx status", async () => {
    const channel = new WebhookChannel({ fetch: failingFetch });
    await expect(
      channel.publish(target({ destination: "https://hooks.example.com/x" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/webhook publish failed: 500/);
  });
});
