import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookChannel } from "../src/engine/notifications/channels/webhook.js";
import { verifyWebhookSignature } from "../src/engine/webhooks/hmacSignature.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Generic webhook channel tests. Injected fetch double + in-memory secrets. The
// destination is ALWAYS a credential ref resolved through the secret store.

const DEST_REF = "credential/webhook/alerts";
const DEST_URL = "https://hooks.example.com/ingest";

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "webhook",
    destination: overrides.destination ?? DEST_REF,
    label: "webhook alerts",
    enabled: true,
    baseUrl: null,
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
  async list(prefix: string): Promise<string[]> {
    return Object.keys(this.map).filter((ref) => ref.startsWith(prefix));
  }
}

const resolvingSecrets = (): SecretStore => new MemorySecrets({ [DEST_REF]: DEST_URL });

describe("WebhookChannel", () => {
  it("resolves a credential ref and POSTs the raw payload shape", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const channel = new WebhookChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), {
      title: "run failed",
      body: "details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
      tags: ["tanren"],
    });
    expect(captured!.url).toBe(DEST_URL);
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

  it("omits optional fields that are unset", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("ok", { status: 200 });
    };
    const channel = new WebhookChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(captured!.url).toBe(DEST_URL);
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("tags");
  });

  it("POSTs with a JSON content-type header", async () => {
    let captured: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = init as RequestInit;
      return new Response("ok", { status: 200 });
    };
    const channel = new WebhookChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), {
      title: "t",
      body: "b",
      severity: "info",
      eventName: "run.started",
    });
    expect(captured!.method).toBe("POST");
    expect((captured!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("forwards the severity and eventName verbatim", async () => {
    let captured: RequestInit | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = init as RequestInit;
      return new Response("ok", { status: 200 });
    };
    const channel = new WebhookChannel({ fetch: fakeFetch, secrets: resolvingSecrets() });
    await channel.publish(target(), {
      title: "t",
      body: "b",
      severity: "warn",
      eventName: "ci.failed",
    });
    const body = JSON.parse(captured!.body as string) as Record<string, unknown>;
    expect(body.severity).toBe("warn");
    expect(body.eventName).toBe("ci.failed");
  });

  it("throws when a credential ref cannot be resolved", async () => {
    const channel = new WebhookChannel({ fetch: failingFetch, secrets: new MemorySecrets({}) });
    await expect(
      channel.publish(target({ destination: "credential/webhook/missing" }), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/missing webhook webhook credential ref/u);
  });

  it("throws when the endpoint returns a non-2xx status", async () => {
    const channel = new WebhookChannel({ fetch: failingFetch, secrets: resolvingSecrets() });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/webhook publish failed: 500/u);
  });
});

function captureFetch() {
  const captured: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    captured.push({ url: String(url), init: init as RequestInit });
    return new Response("ok", { status: 200 });
  };
  return { captured, fetchImpl };
}

describe("WebhookChannel signing (P-INT-6)", () => {
  const SIGNING_SECRET = "per-target-signing-secret";
  const payload = {
    title: "run failed",
    body: "details",
    severity: "fail" as const,
    eventName: "run.failed",
  };

  it("signs the body with the per-target secret and carries a timestamp header", async () => {
    const { captured, fetchImpl } = captureFetch();
    const secrets = new MemorySecrets({ [DEST_REF]: DEST_URL, "credential/webhook-signing/t": SIGNING_SECRET });
    const channel = new WebhookChannel({ fetch: fetchImpl, secrets, nowMs: () => 1_700_000_000_000 });
    await channel.publish(target(), payload);

    const headers = captured[0]!.init.headers as Record<string, string>;
    const signature = headers["X-Tanren-Signature"];
    const timestamp = headers["X-Tanren-Timestamp"];
    expect(timestamp).toBe(String(1_700_000_000));
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/u);

    // The signature is verifiable with the secret over the EXACT body bytes.
    const body = captured[0]!.init.body as string;
    const check = verifyWebhookSignature({
      rawBody: body,
      signatureHeader: signature,
      timestampHeader: timestamp,
      secret: SIGNING_SECRET,
    });
    expect(check.ok).toBe(true);

    // And the digest matches a manual HMAC over `<timestamp>.<body>`.
    const expected = createHmac("sha256", SIGNING_SECRET).update(`${timestamp}.${body}`, "utf8").digest("hex");
    expect(signature).toBe(`sha256=${expected}`);
  });

  it("sends UNSIGNED when no signing secret is configured (sign-if-configured fallback)", async () => {
    const { captured, fetchImpl } = captureFetch();
    // The destination ref resolves, but no signing secret at the signing ref.
    const secrets = new MemorySecrets({ [DEST_REF]: DEST_URL });
    const channel = new WebhookChannel({ fetch: fetchImpl, secrets });
    await channel.publish(target(), payload);

    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["X-Tanren-Signature"]).toBeUndefined();
    expect(headers["X-Tanren-Timestamp"]).toBeUndefined();
  });

  it("never leaks the signing secret into headers, the body, or the URL", async () => {
    const { captured, fetchImpl } = captureFetch();
    const secrets = new MemorySecrets({ [DEST_REF]: DEST_URL, "credential/webhook-signing/t": SIGNING_SECRET });
    const channel = new WebhookChannel({ fetch: fetchImpl, secrets });
    await channel.publish(target(), payload);

    const { url, init } = captured[0]!;
    const serialized = `${url} ${JSON.stringify(init.headers)} ${String(init.body)}`;
    expect(serialized).not.toContain(SIGNING_SECRET);
  });
});
