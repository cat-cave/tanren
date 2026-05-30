import { describe, expect, it } from "vitest";
import { TeamsChannel } from "../src/engine/notifications/channels/teams.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Teams channel tests. Injected fetch double + in-memory secret store so
// dispatch is asserted without a real webhook.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "teams",
    destination: overrides.destination ?? "credential/teams/alerts",
    label: "teams alerts",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const failingFetch: typeof fetch = async () => new Response("nope", { status: 400, statusText: "Bad Request" });

class MemorySecrets implements SecretStore {
  constructor(private readonly map: Record<string, string>) {}
  async put(): Promise<void> {}
  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.map[ref];
    return value === undefined ? undefined : { ref, value };
  }
  async delete(): Promise<void> {}
}

describe("TeamsChannel", () => {
  it("resolves a credential ref and POSTs a MessageCard body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("1", { status: 200 });
    };
    const secrets = new MemorySecrets({
      "credential/teams/alerts": "https://outlook.office.com/webhook/abc",
    });
    const channel = new TeamsChannel({ fetch: fakeFetch, secrets });
    await channel.publish(target(), {
      title: "[FAIL] run.failed",
      body: "run failed details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
      tags: ["tanren"],
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://outlook.office.com/webhook/abc");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body as string) as {
      "@type": string;
      title: string;
      themeColor: string;
      potentialAction: Array<{ targets: Array<{ uri: string }> }>;
    };
    expect(body["@type"]).toBe("MessageCard");
    expect(body.title).toBe("[FAIL] run.failed");
    expect(body.themeColor).toBe("E01E5A");
    expect(body.potentialAction[0]?.targets[0]?.uri).toBe("https://tanren.example/runs/run_1");
  });

  it("uses a full webhook URL destination verbatim without a secret store", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("1", { status: 200 });
    };
    const channel = new TeamsChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://outlook.office.com/webhook/x" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(capturedUrl).toBe("https://outlook.office.com/webhook/x");
  });

  it("throws when Teams returns a non-2xx status", async () => {
    const channel = new TeamsChannel({ fetch: failingFetch });
    await expect(
      channel.publish(target({ destination: "https://outlook.office.com/webhook/x" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/teams publish failed: 400/);
  });

  it("throws when a credential ref cannot be resolved", async () => {
    const channel = new TeamsChannel({ secrets: new MemorySecrets({}) });
    await expect(
      channel.publish(target({ destination: "credential/teams/missing" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/missing teams webhook credential ref/);
  });

  interface Card {
    "@type": string;
    "@context": string;
    themeColor: string;
    summary: string;
    title: string;
    text: string;
    sections: Array<{ facts: Array<{ name: string; value: string }> }>;
    potentialAction?: Array<{ "@type": string; name: string; targets: Array<{ os: string; uri: string }> }>;
  }

  async function capture(payload: Parameters<TeamsChannel["publish"]>[1]): Promise<{
    headers: Record<string, string>;
    card: Card;
  }> {
    let init: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, i) => {
      init = i as RequestInit;
      return new Response("1", { status: 200 });
    };
    const channel = new TeamsChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "https://outlook.office.com/webhook/x" }), payload);
    return { headers: init!.headers as Record<string, string>, card: JSON.parse(init!.body as string) };
  }

  it("stamps the MessageCard envelope, JSON content-type, summary, title, and body text", async () => {
    const { headers, card } = await capture({
      title: "the title",
      body: "the body",
      severity: "info",
      eventName: "run.started",
    });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(card["@type"]).toBe("MessageCard");
    expect(card["@context"]).toBe("http://schema.org/extensions");
    expect(card.summary).toBe("the title");
    expect(card.title).toBe("the title");
    expect(card.text).toBe("the body");
  });

  it("lists event then severity facts in order, then tags when present", async () => {
    const { card } = await capture({
      title: "t",
      body: "b",
      severity: "warn",
      eventName: "ci.failed",
      tags: ["tanren", "x"],
    });
    expect(card.sections[0]?.facts).toEqual([
      { name: "event", value: "ci.failed" },
      { name: "severity", value: "warn" },
      { name: "tags", value: "tanren, x" },
    ]);
  });

  it("omits the tags fact when payload.tags is empty", async () => {
    const { card } = await capture({
      title: "t",
      body: "b",
      severity: "warn",
      eventName: "ci.failed",
      tags: [],
    });
    expect(card.sections[0]?.facts).toEqual([
      { name: "event", value: "ci.failed" },
      { name: "severity", value: "warn" },
    ]);
  });

  it("maps each severity to its theme color", async () => {
    const cases: Array<[Parameters<TeamsChannel["publish"]>[1]["severity"], string]> = [
      ["ok", "2EB67D"],
      ["info", "1264A3"],
      ["warn", "ECB22E"],
      ["fail", "E01E5A"],
    ];
    for (const [severity, color] of cases) {
      const { card } = await capture({ title: "t", body: "b", severity, eventName: "run.failed" });
      expect(card.themeColor).toBe(color);
    }
  });

  it("omits potentialAction when payload.url is unset and includes it when set", async () => {
    const without = await capture({ title: "t", body: "b", severity: "info", eventName: "run.started" });
    expect(without.card.potentialAction).toBeUndefined();
    const withUrl = await capture({
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.completed",
      url: "https://tanren.example/runs/run_1",
    });
    const action = withUrl.card.potentialAction![0]!;
    expect(action["@type"]).toBe("OpenUri");
    expect(action.name).toBe("view run");
    expect(action.targets[0]).toEqual({ os: "default", uri: "https://tanren.example/runs/run_1" });
  });

  it("uses an http:// destination verbatim", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("1", { status: 200 });
    };
    const channel = new TeamsChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "http://outlook.internal/x" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(capturedUrl).toBe("http://outlook.internal/x");
  });

  it("throws when a credential ref is given but no secret store is wired", async () => {
    const channel = new TeamsChannel({});
    await expect(
      channel.publish(target({ destination: "credential/teams/alerts" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/teams channel needs a secret store/);
  });
});
