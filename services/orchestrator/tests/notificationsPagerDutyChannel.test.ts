import { describe, expect, it } from "vitest";
import { PagerDutyChannel } from "../src/engine/notifications/channels/pagerduty.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// PagerDuty Events API v2 channel tests. Injected fetch double + secret store.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "pagerduty",
    destination: overrides.destination ?? "credential/pagerduty/routing-key",
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

describe("PagerDutyChannel", () => {
  it("resolves a routing-key ref and POSTs a trigger event", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("{}", { status: 202 });
    };
    const secrets = new MemorySecrets({
      "credential/pagerduty/routing-key": "R0UTINGKEY",
    });
    const channel = new PagerDutyChannel({
      fetch: fakeFetch,
      secrets,
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
    expect(body.routing_key).toBe("R0UTINGKEY");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("critical");
    expect(body.payload.summary).toBe("run failed");
    expect(body.payload.source).toBe("run.failed");
    expect(body.client_url).toBe("https://tanren.example/runs/run_1");
  });

  it("uses a bare routing key destination verbatim", async () => {
    let body: { routing_key: string } | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      body = JSON.parse((init as RequestInit).body as string) as { routing_key: string };
      return new Response("{}", { status: 202 });
    };
    const channel = new PagerDutyChannel({ fetch: fakeFetch });
    await channel.publish(target({ destination: "BAREKEY1234567890BAREKEY12345678" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(body!.routing_key).toBe("BAREKEY1234567890BAREKEY12345678");
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
    const channel = new PagerDutyChannel({ fetch: fakeFetch });
    for (const severity of ["ok", "info", "warn", "fail"] as const) {
      await channel.publish(target({ destination: "BAREKEY" }), {
        title: "t",
        body: "b",
        severity,
        eventName: "run.failed",
      });
    }
    expect(captured).toEqual(["info", "info", "warning", "critical"]);
  });

  it("throws when PagerDuty does not return 202", async () => {
    const channel = new PagerDutyChannel({ fetch: failingFetch });
    await expect(
      channel.publish(target({ destination: "BAREKEY" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/pagerduty publish failed: 400/);
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
    ).rejects.toThrow(/missing pagerduty routing-key credential ref/);
  });
});
