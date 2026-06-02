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
      "xoxb-token",
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
      "xoxb-token",
      fetchReturning({ ok: true, channel: { id: "C_new", name: "tanren-x", is_member: true } }),
    );
    const channel = await transport.createConversation({ name: "tanren-x" });
    expect(channel).toEqual({ id: "C_new", name: "tanren-x", isMember: true });
  });

  it("surfaces a non-ok Slack envelope as a thrown Error carrying the slack error code", async () => {
    const transport = new FetchSlackApiTransport("xoxb-token", fetchReturning({ ok: false, error: "name_taken" }));
    await expect(transport.createConversation({ name: "dup" })).rejects.toThrow(/name_taken/u);
  });

  it("resolves the bot user id from auth.test", async () => {
    const transport = new FetchSlackApiTransport("xoxb-token", fetchReturning({ ok: true, user_id: "U_BOT" }));
    expect(await transport.authTest()).toEqual({ botUserId: "U_BOT" });
  });

  it("throws on a non-2xx HTTP response", async () => {
    const failing = (async () =>
      new Response("boom", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
    const transport = new FetchSlackApiTransport("xoxb-token", failing);
    await expect(transport.joinConversation("C1")).rejects.toThrow(/HTTP 500/u);
  });
});
