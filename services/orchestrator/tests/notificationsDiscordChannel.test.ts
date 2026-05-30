import { describe, expect, it } from "vitest";
import { DiscordChannel } from "../src/engine/notifications/channels/discord.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Discord channel tests. Injected fetch double + in-memory secret store.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "discord",
    destination: overrides.destination ?? "credential/discord/alerts",
    label: "discord alerts",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const failingFetch: typeof fetch = async () => new Response("bad", { status: 400, statusText: "Bad Request" });

class MemorySecrets implements SecretStore {
  constructor(private readonly map: Record<string, string>) {}
  async put(): Promise<void> {}
  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.map[ref];
    return value === undefined ? undefined : { ref, value };
  }
  async delete(): Promise<void> {}
}

describe("DiscordChannel", () => {
  it("resolves a credential ref and POSTs a content+embeds body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response(null, { status: 204 });
    };
    const secrets = new MemorySecrets({
      "credential/discord/alerts": "https://discord.com/api/webhooks/1/abc",
    });
    const channel = new DiscordChannel({ fetch: fakeFetch, secrets });
    await channel.publish(target(), {
      title: "[FAIL] run.failed",
      body: "run failed details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://discord.com/api/webhooks/1/abc");
    const body = JSON.parse(captured!.init.body as string) as {
      content: string;
      embeds: Array<{ title: string; description: string; color: number; url?: string }>;
    };
    expect(body.content).toContain("[FAIL] run.failed");
    expect(body.embeds[0]?.description).toBe("run failed details");
    expect(body.embeds[0]?.color).toBe(0xe01e5a);
    expect(body.embeds[0]?.url).toBe("https://tanren.example/runs/run_1");
  });

  it("uses a full webhook URL destination verbatim without a secret store", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(null, { status: 204 });
    };
    const channel = new DiscordChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://discord.com/api/webhooks/x" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(capturedUrl).toBe("https://discord.com/api/webhooks/x");
  });

  it("throws when Discord returns a non-2xx status", async () => {
    const channel = new DiscordChannel({ fetch: failingFetch });
    await expect(
      channel.publish(target({ destination: "https://discord.com/api/webhooks/x" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/discord publish failed: 400/u);
  });

  interface Embed {
    title: string;
    description: string;
    color: number;
    url?: string;
    fields: Array<{ name: string; value: string; inline: boolean }>;
  }

  async function capture(payload: Parameters<DiscordChannel["publish"]>[1]): Promise<{
    headers: Record<string, string>;
    body: { content: string; embeds: Embed[] };
  }> {
    let init: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, i) => {
      init = i as RequestInit;
      return new Response(null, { status: 204 });
    };
    const channel = new DiscordChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://discord.com/api/webhooks/x" }), payload);
    return { headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) };
  }

  it("sends a JSON content-type and sets content + embed title to the payload title", async () => {
    const { headers, body } = await capture({
      title: "the title",
      body: "the body",
      severity: "info",
      eventName: "run.started",
    });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(body.content).toBe("the title");
    expect(body.embeds[0]?.title).toBe("the title");
    expect(body.embeds[0]?.description).toBe("the body");
  });

  it("lists event then severity fields (both inline) then a non-inline tags field when present", async () => {
    const { body } = await capture({
      title: "t",
      body: "b",
      severity: "warn",
      eventName: "ci.failed",
      tags: ["tanren", "x"],
    });
    expect(body.embeds[0]?.fields).toEqual([
      { name: "event", value: "ci.failed", inline: true },
      { name: "severity", value: "warn", inline: true },
      { name: "tags", value: "tanren, x", inline: false },
    ]);
  });

  it("omits the tags field when payload.tags is empty", async () => {
    const { body } = await capture({
      title: "t",
      body: "b",
      severity: "warn",
      eventName: "ci.failed",
      tags: [],
    });
    expect(body.embeds[0]?.fields).toEqual([
      { name: "event", value: "ci.failed", inline: true },
      { name: "severity", value: "warn", inline: true },
    ]);
  });

  it("maps each severity to its embed color", async () => {
    const cases: Array<[Parameters<DiscordChannel["publish"]>[1]["severity"], number]> = [
      ["ok", 0x2eb67d],
      ["info", 0x1264a3],
      ["warn", 0xecb22e],
      ["fail", 0xe01e5a],
    ];
    for (const [severity, color] of cases) {
      const { body } = await capture({ title: "t", body: "b", severity, eventName: "run.failed" });
      expect(body.embeds[0]?.color).toBe(color);
    }
  });

  it("omits embed.url when payload.url is unset", async () => {
    const { body } = await capture({ title: "t", body: "b", severity: "info", eventName: "run.started" });
    expect(body.embeds[0]).not.toHaveProperty("url");
  });

  it("uses an http:// destination verbatim", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(null, { status: 204 });
    };
    const channel = new DiscordChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "http://discord.internal/x" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(capturedUrl).toBe("http://discord.internal/x");
  });

  it("throws when a credential ref is given but no secret store is wired", async () => {
    const channel = new DiscordChannel({});
    await expect(
      channel.publish(target({ destination: "credential/discord/alerts" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/discord channel needs a secret store/u);
  });
});
