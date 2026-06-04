import { describe, expect, it } from "vitest";
import { PagerDutyChannel } from "../src/engine/notifications/channels/pagerduty.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// PagerDuty Events API v2 channel tests. Injected fetch double + secret store.
// The destination is ALWAYS a credential ref pointing at the routing key
// (resolved through the secret store).

const ROUTING_KEY_REF = "credential/pagerduty/routing-key";
const ROUTING_KEY = "R0UTINGKEY";

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "pagerduty",
    destination: overrides.destination ?? ROUTING_KEY_REF,
    label: "pagerduty oncall",
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

const resolvingSecrets = (): SecretStore => new MemorySecrets({ [ROUTING_KEY_REF]: ROUTING_KEY });

describe("PagerDutyChannel", () => {
  it("resolves a routing-key ref and POSTs a trigger event", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("{}", { status: 202 });
    };
    const channel = new PagerDutyChannel({
      fetch: fakeFetch,
      secrets: resolvingSecrets(),
      apiBaseUrl: "https://events.pagerduty.test",
    });
    await channel.publish(target(), {
      title: "run failed",
      body: "details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
      tags: ["tanren"],
    });
    expect(captured!.url).toBe("https://events.pagerduty.test/v2/enqueue");
    const body = JSON.parse(captured!.init.body as string) as {
      routing_key: string;
      event_action: string;
      payload: { summary: string; severity: string; source: string; custom_details: unknown };
      client_url?: string;
    };
    expect(body.routing_key).toBe(ROUTING_KEY);
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("critical");
    expect(body.payload.summary).toBe("run failed");
    expect(body.payload.source).toBe("run.failed");
    expect(body.client_url).toBe("https://tanren.example/runs/run_1");
  });

  it("maps severity to the PagerDuty scale", async () => {
    const captured: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        payload: { severity: string };
      };
      captured.push(body.payload.severity);
      return new Response("{}", { status: 202 });
    };
    const channel = new PagerDutyChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    for (const severity of ["ok", "info", "warn", "fail"] as const) {
      await channel.publish(target(), {
        title: "t",
        body: "b",
        severity,
        eventName: "run.failed",
      });
    }
    expect(captured).toEqual(["info", "info", "warning", "critical"]);
  });

  it("throws when PagerDuty does not return 202", async () => {
    const channel = new PagerDutyChannel({ fetch: failingFetch, secrets: resolvingSecrets() });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/pagerduty publish failed: 400/u);
  });

  it("throws when a credential ref cannot be resolved", async () => {
    const channel = new PagerDutyChannel({ secrets: new MemorySecrets({}) });
    await expect(
      channel.publish(target({ destination: "credential/pagerduty/missing" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/missing pagerduty routing-key credential ref/u);
  });

  interface Event {
    routing_key: string;
    event_action: string;
    payload: {
      summary: string;
      source: string;
      severity: string;
      custom_details: { body: string; tags?: string[] };
    };
    client?: string;
    client_url?: string;
  }

  async function capture(
    payload: Parameters<PagerDutyChannel["publish"]>[1],
  ): Promise<{ url: string; headers: Record<string, string>; event: Event }> {
    let init: { url: string; req: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, req) => {
      init = { url: String(url), req: req as RequestInit };
      return new Response("{}", { status: 202 });
    };
    const channel = new PagerDutyChannel({
      fetch: fakeFetch,
      secrets: resolvingSecrets(),
      apiBaseUrl: "https://events.pagerduty.test",
    });
    await channel.publish(target(), payload);
    return {
      url: init!.url,
      headers: init!.req.headers as Record<string, string>,
      event: JSON.parse(init!.req.body as string),
    };
  }

  it("strips a trailing slash from the api base before appending /v2/enqueue", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 202 });
    };
    const channel = new PagerDutyChannel({
      fetch: fakeFetch,
      secrets: resolvingSecrets(),
      apiBaseUrl: "https://events.pagerduty.test/",
    });
    await channel.publish(target(), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(capturedUrl).toBe("https://events.pagerduty.test/v2/enqueue");
  });

  it("sends a JSON content-type and the custom_details body", async () => {
    const { headers, event } = await capture({
      title: "t",
      body: "the detail body",
      severity: "info",
      eventName: "run.started",
    });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(event.payload.custom_details.body).toBe("the detail body");
  });

  it("includes custom_details.tags only when payload.tags is present and non-empty", async () => {
    const withTags = await capture({
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
      tags: ["tanren", "x"],
    });
    expect(withTags.event.payload.custom_details.tags).toEqual(["tanren", "x"]);
    const without = await capture({ title: "t", body: "b", severity: "info", eventName: "run.started" });
    expect(without.event.payload.custom_details).not.toHaveProperty("tags");
  });

  it("omits client/client_url when payload.url is unset and sets them when present", async () => {
    const without = await capture({ title: "t", body: "b", severity: "info", eventName: "run.started" });
    expect(without.event).not.toHaveProperty("client");
    expect(without.event).not.toHaveProperty("client_url");
    const withUrl = await capture({
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.completed",
      url: "https://tanren.example/runs/run_1",
    });
    expect(withUrl.event.client).toBe("tanren");
    expect(withUrl.event.client_url).toBe("https://tanren.example/runs/run_1");
  });
});
