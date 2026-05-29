import { describe, expect, it } from "vitest";
import {
  EmailChannel,
  HttpEmailTransport,
  type EmailMessage,
  type EmailTransport
} from "../src/engine/notifications/channels/email.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Email channel tests. The transport port is mocked directly; the default
// HttpEmailTransport is exercised with an injected fetch + secret store.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "email",
    destination: overrides.destination ?? "oncall@example.com",
    label: "email oncall",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

const failingFetch: typeof fetch = async () =>
  new Response("bad", { status: 502, statusText: "Bad Gateway" });

class MemorySecrets implements SecretStore {
  constructor(private readonly map: Record<string, string>) {}
  async put(): Promise<void> {}
  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.map[ref];
    return value === undefined ? undefined : { ref, value };
  }
  async delete(): Promise<void> {}
}

class MockTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  private readonly throws: boolean;
  constructor(opts: { throws?: boolean } = {}) {
    this.throws = opts.throws ?? false;
  }
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    if (this.throws) throw new Error("transport down");
  }
}

describe("EmailChannel", () => {
  it("hands the recipient + rendered message to the transport port", async () => {
    const transport = new MockTransport();
    const channel = new EmailChannel({ transport });
    await channel.publish(target(), {
      title: "[FAIL] run.failed",
      body: "run failed details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
      tags: ["tanren"]
    });
    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0]!;
    expect(message.to).toBe("oncall@example.com");
    expect(message.subject).toBe("[FAIL] run.failed");
    expect(message.text).toContain("run failed details");
    expect(message.text).toContain("event: run.failed");
    expect(message.text).toContain("severity: fail");
    expect(message.text).toContain("url: https://tanren.example/runs/run_1");
  });

  it("propagates transport failures", async () => {
    const transport = new MockTransport({ throws: true });
    const channel = new EmailChannel({ transport });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started"
      })
    ).rejects.toThrow(/transport down/);
  });
});

describe("HttpEmailTransport (default)", () => {
  it("resolves API creds from the secret store and POSTs the message", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const secrets = new MemorySecrets({
      "credential/email/api-endpoint": "https://email.example.com/send",
      "credential/email/api-key": "key_123"
    });
    const transport = new HttpEmailTransport({ fetch: fakeFetch, secrets, from: "alerts@tanren" });
    await transport.send({ to: "oncall@example.com", subject: "s", text: "b" });
    expect(captured!.url).toBe("https://email.example.com/send");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer key_123");
    const body = JSON.parse(captured!.init.body as string) as Record<string, string>;
    expect(body).toEqual({
      from: "alerts@tanren",
      to: "oncall@example.com",
      subject: "s",
      text: "b"
    });
  });

  it("throws when the email API returns a non-2xx status", async () => {
    const secrets = new MemorySecrets({
      "credential/email/api-endpoint": "https://email.example.com/send",
      "credential/email/api-key": "key_123"
    });
    const transport = new HttpEmailTransport({ fetch: failingFetch, secrets });
    await expect(transport.send({ to: "x@example.com", subject: "s", text: "b" })).rejects.toThrow(
      /email publish failed: 502/
    );
  });

  it("throws when credential refs are missing", async () => {
    const transport = new HttpEmailTransport({ secrets: new MemorySecrets({}) });
    await expect(transport.send({ to: "x@example.com", subject: "s", text: "b" })).rejects.toThrow(
      /missing email API endpoint credential ref/
    );
  });
});
