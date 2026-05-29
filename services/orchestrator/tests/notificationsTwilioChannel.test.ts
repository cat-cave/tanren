import { describe, expect, it } from "vitest";
import { TwilioChannel } from "../src/engine/notifications/channels/twilio.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { NotificationTargetRow } from "../src/engine/notifications/index.js";

// Twilio SMS channel tests. Injected fetch double + in-memory secret store so
// the REST request shape is asserted without a real account.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "twilio",
    destination: overrides.destination ?? "+15557654321",
    label: "twilio oncall",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const failingFetch: typeof fetch = async () => new Response("bad", { status: 401, statusText: "Unauthorized" });

function secrets(): SecretStore {
  const map: Record<string, string> = {
    "credential/twilio/account-sid": "ACxxx",
    "credential/twilio/auth-token": "tok_secret",
    "credential/twilio/from-number": "+15551234567",
  };
  return {
    async put() {},
    async get(ref: string): Promise<SecretValue | undefined> {
      const value = map[ref];
      return value === undefined ? undefined : { ref, value };
    },
    async delete() {},
  };
}

describe("TwilioChannel", () => {
  it("POSTs a form-encoded message to the Messages resource with Basic auth", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("{}", { status: 201 });
    };
    const channel = new TwilioChannel({
      fetch: fakeFetch,
      secrets: secrets(),
      apiBaseUrl: "https://api.twilio.test",
    });
    await channel.publish(target(), {
      title: "run failed",
      body: "details",
      severity: "fail",
      eventName: "run.failed",
      url: "https://tanren.example/runs/run_1",
    });
    expect(captured!.url).toBe("https://api.twilio.test/2010-04-01/Accounts/ACxxx/Messages.json");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("ACxxx:tok_secret").toString("base64")}`);
    const form = new URLSearchParams(captured!.init.body as string);
    expect(form.get("To")).toBe("+15557654321");
    expect(form.get("From")).toBe("+15551234567");
    expect(form.get("Body")).toContain("[FAIL] run failed");
    expect(form.get("Body")).toContain("https://tanren.example/runs/run_1");
  });

  it("throws when Twilio returns a non-2xx status", async () => {
    const channel = new TwilioChannel({ fetch: failingFetch, secrets: secrets() });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/twilio publish failed: 401/);
  });

  it("throws when credentials are missing", async () => {
    const empty: SecretStore = {
      async put() {},
      async get() {
        return undefined;
      },
      async delete() {},
    };
    const channel = new TwilioChannel({ secrets: empty });
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/missing twilio credential ref/);
  });

  it("throws when no secret store is supplied", async () => {
    const channel = new TwilioChannel({});
    await expect(
      channel.publish(target(), {
        title: "t",
        body: "b",
        severity: "info",
        eventName: "run.started",
      }),
    ).rejects.toThrow(/needs a secret store/);
  });
});
