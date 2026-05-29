import { describe, expect, it } from "vitest";
import { NtfyChannel } from "../src/engine/notifications/channels/ntfy.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// P2A-0017 ntfy integration smoke. Uses an injected fetch double to assert
// the URL resolution, headers, and body shape match the ntfy server's
// expectations without requiring a live broker.

const failingFetch: typeof fetch = async () => new Response("nope", { status: 503, statusText: "Service Unavailable" });

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "ntfy",
    destination: overrides.destination ?? "tanren-runs",
    label: "ntfy default",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("NtfyChannel", () => {
  it("POSTs to {baseUrl}/{topic} when destination is a bare topic", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const channel = new NtfyChannel({ fetch: fakeFetch, baseUrl: "http://ntfy.local" });
    await channel.publish(target({ destination: "tanren-runs" }), {
      title: "[FAIL] run.failed",
      body: "run failed",
      severity: "fail",
      eventName: "run.failed",
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://ntfy.local/tanren-runs");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("[FAIL] run.failed");
    expect(headers["Priority"]).toBe("urgent");
    expect(headers["Tags"]).toContain("severity:fail");
    expect(headers["Tags"]).toContain("event:run.failed");
    const body = JSON.parse(captured!.init.body as string) as { message: string; severity: string };
    expect(body.message).toBe("run failed");
    expect(body.severity).toBe("fail");
  });

  it("POSTs to the destination URL verbatim when it is already a full URL", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("ok", { status: 200 });
    };
    const channel = new NtfyChannel({ fetch: fakeFetch, baseUrl: "http://unused" });
    await channel.publish(target({ destination: "https://ntfy.example.com/private-topic" }), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(capturedUrl).toBe("https://ntfy.example.com/private-topic");
  });

  it("maps severity to ntfy priority", async () => {
    const captured: Array<Record<string, string>> = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured.push((init as RequestInit).headers as Record<string, string>);
      return new Response("ok", { status: 200 });
    };
    const channel = new NtfyChannel({ fetch: fakeFetch, baseUrl: "http://ntfy" });
    for (const severity of ["ok", "info", "warn", "fail"] as const) {
      await channel.publish(target(), {
        title: "t",
        body: "b",
        severity,
        eventName: "run.failed",
      });
    }
    expect(captured.map((h) => h["Priority"])).toEqual(["low", "default", "high", "urgent"]);
  });

  it("throws when the server returns a non-2xx status", async () => {
    const channel = new NtfyChannel({ fetch: failingFetch, baseUrl: "http://ntfy" });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/ntfy publish failed: 503/);
  });

  it("adds a Click header and url field when payload.url is set", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const channel = new NtfyChannel({ fetch: fakeFetch, baseUrl: "http://ntfy" });
    await channel.publish(target(), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.completed",
      url: "https://tanren.example/runs/run_1",
    });
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Click"]).toBe("https://tanren.example/runs/run_1");
    const body = JSON.parse(captured!.init.body as string) as { url: string };
    expect(body.url).toBe("https://tanren.example/runs/run_1");
  });
});
