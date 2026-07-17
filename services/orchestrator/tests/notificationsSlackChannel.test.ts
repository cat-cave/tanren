import { describe, expect, it } from "vitest";
import { SlackChannel } from "../src/engine/notifications/channels/slack.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Slack channel tests. Uses an injected fetch double + an in-memory
// secret store so dispatch is asserted without a real webhook. The destination
// is ALWAYS a credential ref resolved through the secret store.

const WEBHOOK_REF = "credential/slack/alerts";
const WEBHOOK_URL = "https://hooks.slack.com/services/T/B/secret";

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "slack",
    destination: overrides.destination ?? WEBHOOK_REF,
    label: "slack alerts",
    enabled: true,
    baseUrl: null,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
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

const resolvingSecrets = (): SecretStore => new MemorySecrets({ [WEBHOOK_REF]: WEBHOOK_URL });

describe("SlackChannel", () => {
  it("resolves a credential ref to the webhook URL and POSTs the message", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const channel = new SlackChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), {
      title: "[FAIL] run.failed",
      body: "run failed details",
      severity: "fail",
      eventName: "run.failed",
      tags: ["tanren", "severity:fail"],
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(WEBHOOK_URL);
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

  it("adds a view-run button when payload.url is set", async () => {
    let captured: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = init as RequestInit;
      return new Response("ok", { status: 200 });
    };
    const channel = new SlackChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.completed",
      url: "https://tanren.example/runs/run_1",
    });
    const body = JSON.parse(captured!.body as string) as { blocks: unknown[] };
    expect(JSON.stringify(body.blocks)).toContain("https://tanren.example/runs/run_1");
  });

  it("throws when Slack returns a non-2xx status", async () => {
    const channel = new SlackChannel({ fetch: failingFetch, secrets: resolvingSecrets() });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/slack publish failed: 400/u);
  });

  it("throws when a credential ref cannot be resolved", async () => {
    const channel = new SlackChannel({ secrets: new MemorySecrets({}) });
    await expect(
      channel.publish(target({ destination: "credential/slack/missing" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/missing Slack webhook credential ref/u);
  });

  // NEGATIVE CONTROL (gv-6 provisioner ↔ channel contract): a destination that
  // resolves to a Slack BOT TOKEN (xoxb-…) must be rejected — never POSTed as if
  // it were an incoming-webhook URL. fetch must NOT be invoked.
  it("rejects a resolved bot token (xoxb-…) and never POSTs it as a webhook", async () => {
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    };
    const botTokenSecrets = new MemorySecrets({ "credential/slack/bot": "xoxb-1234567890-abcdef" });
    const channel = new SlackChannel({ fetch: spyFetch, secrets: botTokenSecrets });
    await expect(
      channel.publish(target({ destination: "credential/slack/bot" }), {
        title: "t",
        body: "b",
        severity: "fail",
        eventName: "run.failed",
      }),
    ).rejects.toThrow(/bot\/app token, not an incoming-webhook URL/u);
    expect(fetchCalls).toBe(0);
  });

  // A resolved non-URL (or non-https) value is likewise rejected before any POST.
  it("rejects a resolved non-https destination and never POSTs it", async () => {
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    };
    const badSecrets = new MemorySecrets({ "credential/slack/bad": "not-a-url" });
    const channel = new SlackChannel({ fetch: spyFetch, secrets: badSecrets });
    await expect(
      channel.publish(target({ destination: "credential/slack/bad" }), {
        title: "t",
        body: "b",
        severity: "fail",
        eventName: "run.failed",
      }),
    ).rejects.toThrow(/not a valid incoming-webhook URL/u);
    expect(fetchCalls).toBe(0);
  });

  async function capture(payload: Parameters<SlackChannel["publish"]>[1]): Promise<{
    headers: Record<string, string>;
    body: {
      text: string;
      blocks: Array<{ type: string; text?: { type: string; text: string }; elements?: unknown[] }>;
    };
  }> {
    let init: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, i) => {
      init = i as RequestInit;
      return new Response("ok", { status: 200 });
    };
    const channel = new SlackChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), payload);
    return {
      headers: init!.headers as Record<string, string>,
      body: JSON.parse(init!.body as string),
    };
  }

  it("sends a JSON Content-Type header", async () => {
    const { headers } = await capture({ title: "t", body: "b", severity: "info", eventName: "run.started" });
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("builds header/section/context blocks with the severity emoji and code-fenced body", async () => {
    const { body } = await capture({
      title: "run failed",
      body: "the body text",
      severity: "warn",
      eventName: "ci.failed",
    });
    expect(body.blocks[0]?.type).toBe("header");
    expect(body.blocks[0]?.text?.type).toBe("plain_text");
    expect(body.blocks[0]?.text?.text).toBe(":warning: run failed");
    expect(body.text).toBe(":warning: run failed");
    expect(body.blocks[1]?.type).toBe("section");
    expect(body.blocks[1]?.text?.type).toBe("mrkdwn");
    expect(body.blocks[1]?.text?.text).toBe("```the body text```");
    const context = body.blocks[2]!;
    expect(context.type).toBe("context");
    const contextText = (context.elements as Array<{ type: string; text: string }>)[0]!;
    expect(contextText.type).toBe("mrkdwn");
    expect(contextText.text).toBe("*event* ci.failed  |  *severity* warn");
  });

  it("appends a joined tags element to the context block when tags are present", async () => {
    const { body } = await capture({
      title: "t",
      body: "b",
      severity: "ok",
      eventName: "run.completed",
      tags: ["tanren", "severity:ok"],
    });
    const context = body.blocks.find((b) => b.type === "context")!;
    const text = (context.elements as Array<{ text: string }>)[0]!.text;
    expect(text).toBe("*event* run.completed  |  *severity* ok  |  tanren · severity:ok");
  });

  it("omits the tags element when payload.tags is empty", async () => {
    const { body } = await capture({
      title: "t",
      body: "b",
      severity: "ok",
      eventName: "run.completed",
      tags: [],
    });
    const context = body.blocks.find((b) => b.type === "context")!;
    const text = (context.elements as Array<{ text: string }>)[0]!.text;
    expect(text).toBe("*event* run.completed  |  *severity* ok");
  });

  it("omits the actions block when payload.url is unset", async () => {
    const { body } = await capture({ title: "t", body: "b", severity: "info", eventName: "run.started" });
    expect(body.blocks.find((b) => b.type === "actions")).toBeUndefined();
  });

  it("renders a view-run button block with the url when payload.url is set", async () => {
    const { body } = await capture({
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.completed",
      url: "https://tanren.example/runs/run_1",
    });
    const actions = body.blocks.find((b) => b.type === "actions")!;
    const button = (actions.elements as Array<{ type: string; text: { text: string }; url: string }>)[0]!;
    expect(button.type).toBe("button");
    expect(button.text.text).toBe("view run");
    expect(button.url).toBe("https://tanren.example/runs/run_1");
  });

  it("maps each severity to its Slack emoji", async () => {
    const cases: Array<[Parameters<SlackChannel["publish"]>[1]["severity"], string]> = [
      ["ok", ":white_check_mark:"],
      ["info", ":information_source:"],
      ["warn", ":warning:"],
      ["fail", ":rotating_light:"],
    ];
    for (const [severity, emoji] of cases) {
      const { body } = await capture({ title: "t", body: "b", severity, eventName: "run.failed" });
      expect(body.blocks[0]?.text?.text).toBe(`${emoji} t`);
    }
  });

  it("truncates an over-long header to 150 chars with an ellipsis", async () => {
    const { body } = await capture({
      title: "x".repeat(200),
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    const header = body.blocks[0]!.text!.text;
    expect(header.length).toBe(150);
    expect(header.endsWith("...")).toBe(true);
  });
});
