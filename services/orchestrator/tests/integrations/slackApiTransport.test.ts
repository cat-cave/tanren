// FetchSlackApiTransport unit coverage over an INJECTED fetch — no real Slack call
// (CI never touches slack.com). Asserts the Web API envelope handling: ok parsing,
// a non-ok `{ ok:false, error }` envelope surfacing as a thrown Error, bearer-auth
// header, and cursor mapping.

import { describe, expect, it } from "vitest";
import { FetchSlackApiTransport } from "../../src/engine/integrations/slack/slackApiTransport.js";

interface Recorded {
  url: string;
  authorization: string | null;
  body: string;
}

function fetchReturning(payload: unknown, recorder?: Recorded[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    recorder?.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("Authorization"),
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("FetchSlackApiTransport", () => {
  it("lists conversations and maps is_member + the next cursor", async () => {
    const recorder: Recorded[] = [];
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchReturning(
        {
          ok: true,
          channels: [{ id: "C1", name: "general", is_member: true }],
          response_metadata: { next_cursor: "page2" },
        },
        recorder,
      ),
    );
    const result = await transport.listConversations({});
    expect(result.channels).toEqual([{ id: "C1", name: "general", isMember: true }]);
    expect(result.nextCursor).toBe("page2");
    // Bearer auth header carries the token; the body never logs it.
    expect(recorder[0]?.authorization).toBe("Bearer xoxb-token");
    expect(recorder[0]?.url).toContain("conversations.list");
  });

  it("creates a conversation and maps the returned channel", async () => {
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchReturning({ ok: true, channel: { id: "C_new", name: "tanren-x", is_member: true } }),
    );
    const channel = await transport.createConversation({ name: "tanren-x" });
    expect(channel).toEqual({ id: "C_new", name: "tanren-x", isMember: true });
  });

  it("surfaces a non-ok Slack envelope as a thrown Error carrying the slack error code", async () => {
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchReturning({ ok: false, error: "name_taken" }),
    );
    await expect(transport.createConversation({ name: "dup" })).rejects.toThrow(/name_taken/u);
  });

  it("resolves the bot user id from auth.test", async () => {
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchReturning({ ok: true, user_id: "U_BOT" }),
    );
    expect(await transport.authTest()).toEqual({ botUserId: "U_BOT" });
  });

  it("throws on a non-2xx HTTP response", async () => {
    const failing = (async () =>
      new Response("boom", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
    const transport = new FetchSlackApiTransport(async () => "xoxb-token", failing);
    await expect(transport.joinConversation("C1")).rejects.toThrow(/HTTP 500/u);
  });

  it("retries a 429 after the Retry-After delay, then succeeds", async () => {
    let calls = 0;
    const waited: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "2" } });
      }
      return new Response(JSON.stringify({ ok: true, user_id: "U_BOT" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    // Inject a no-op sleep that records the honored wait (no real timers in the test).
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchImpl,
      async (ms) => {
        waited.push(ms);
      },
    );
    expect(await transport.authTest()).toEqual({ botUserId: "U_BOT" });
    expect(calls).toBe(2);
    // The Retry-After header (2s) was honored before the retry.
    expect(waited).toEqual([2000]);
  });

  it("reauthorizes before a retry and performs no second HTTP call after authority expires", async () => {
    let authorityAttempts = 0;
    let httpCalls = 0;
    const tokenForAttempt = async () => {
      authorityAttempts += 1;
      if (authorityAttempts > 1) throw new Error("eligible operation lease expired");
      return "xoxb-token";
    };
    const fetchImpl = (async () => {
      httpCalls += 1;
      return new Response("", { status: 429, headers: { "Retry-After": "1" } });
    }) as unknown as typeof fetch;
    const transport = new FetchSlackApiTransport(tokenForAttempt, fetchImpl, async () => {});

    await expect(transport.authTest()).rejects.toThrow(/expired/u);
    expect(authorityAttempts).toBe(2);
    expect(httpCalls).toBe(1);
  });

  it("retries UNBOUNDED while the 429 cadence is RAMPING (no attempt cap)", async () => {
    // Task #32 (convergence-based): the 429 retry path is UNBOUNDED. The convergence
    // detector treats consecutive 429s as the "ramping" phase until the saturation
    // threshold is crossed — only THEN does an IDENTICAL recurring signal become a proven
    // fixed point. With a finite RAMP-LENGTH of 429s followed by a 200, the retry helper
    // never escalates and the underlying call eventually succeeds; the observed call count
    // is ramp-length + 1 (the final success).
    const rampLength = 4;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= rampLength) {
        return new Response("", { status: 429, headers: { "Retry-After": "1" } });
      }
      return new Response(JSON.stringify({ ok: true, user_id: "U_BOT" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchImpl,
      async () => {},
    );
    expect(await transport.authTest()).toEqual({ botUserId: "U_BOT" });
    // Ramp + 1 success — strictly more than the legacy bounded budget of 4, so this proves
    // the cap is gone (the call would have failed LOUD at the old bounded budget).
    expect(calls).toBe(rampLength + 1);
  });

  it("remains retryable after more than four identical 429 responses", async () => {
    const retryResponses = 6;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= retryResponses) {
        return new Response("", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "1" } });
      }
      return new Response(JSON.stringify({ ok: true, user_id: "U_BOT" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchImpl,
      async () => {},
    );
    await expect(transport.authTest()).resolves.toEqual({ botUserId: "U_BOT" });
    expect(calls).toBe(retryResponses + 1);
  });

  it("honors a long Retry-After verbatim (NO clamp on the server-supplied wait)", async () => {
    // Task #32 DOCTRINE: Slack's Retry-After IS the authoritative external constraint.
    // The legacy 60s clamp (SLACK_MAX_RETRY_AFTER_MS) is GONE — clamping just generates
    // more 429s. A 429 with a 120-second Retry-After (past the old clamp) must be honored
    // verbatim: the injected sleep records exactly 120000ms before the retry, and the
    // second call returns 200. This is the load-bearing assertion the clamp-drop is
    // doctrine-correct.
    let calls = 0;
    const waited: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "120" } });
      }
      return new Response(JSON.stringify({ ok: true, user_id: "U_BOT" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const transport = new FetchSlackApiTransport(
      async () => "xoxb-token",
      fetchImpl,
      async (ms) => {
        waited.push(ms);
      },
    );
    expect(await transport.authTest()).toEqual({ botUserId: "U_BOT" });
    expect(calls).toBe(2);
    // The full 120s wait was honored verbatim — no clamp.
    expect(waited).toEqual([120_000]);
  });
});
