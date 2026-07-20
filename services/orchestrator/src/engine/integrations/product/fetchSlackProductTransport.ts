// in-13: production HTTP transport for direct PRODUCT-plane Slack provisioning.
// It talks to Slack's real Web API with a lease-resolved product bot token. The
// token is used only in the Authorization header and never appears in a result,
// error, receipt, log, or hash.

import type {
  SlackProductChannel,
  SlackProductMessageReceipt,
  SlackProductTransport,
} from "./slackProductProvisioner.js";

const SLACK_API_BASE = "https://slack.com/api";

type SlackRecord = Record<string, unknown>;

/** A fetch-backed direct product Slack transport; production's real API caller. */
export class FetchSlackProductTransport implements SlackProductTransport {
  constructor(
    private readonly tokenForCall: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listChannels(): Promise<readonly SlackProductChannel[]> {
    const channels: SlackProductChannel[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const body = await this.call("conversations.list", {
        limit: "200",
        exclude_archived: "true",
        types: "public_channel,private_channel",
        ...(cursor === undefined ? {} : { cursor }),
      });
      const rawChannels = body["channels"];
      if (!Array.isArray(rawChannels)) {
        throw new TypeError("malformed_slack_channels: conversations.list returned no channels array");
      }
      channels.push(...rawChannels.map((raw) => parseChannel(raw, "conversations.list")));
      const nextCursor = parseNextCursor(body["response_metadata"]);
      if (nextCursor === undefined || nextCursor === "") return channels;
      if (seenCursors.has(nextCursor)) {
        throw new Error(`malformed_slack_cursor: conversations.list repeated cursor '${nextCursor}'`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async createChannel(name: string): Promise<SlackProductChannel> {
    const body = await this.call("conversations.create", { name, is_private: "false" });
    return parseChannel(body["channel"], "conversations.create");
  }

  async joinChannel(channelId: string): Promise<SlackProductChannel> {
    const body = await this.call("conversations.join", { channel: channelId });
    return parseChannel(body["channel"], "conversations.join");
  }

  async postMessage(channelId: string, text: string): Promise<SlackProductMessageReceipt> {
    const body = await this.call("chat.postMessage", { channel: channelId, text });
    return {
      channelId: requiredNonBlankString(body["channel"], "chat.postMessage.channel"),
      messageTs: requiredNonBlankString(body["ts"], "chat.postMessage.ts"),
    };
  }

  private async call(method: string, params: Record<string, string>): Promise<SlackRecord> {
    const token = await this.tokenForCall();
    if (token.trim() === "") {
      throw new Error("direct Slack bot token is blank");
    }
    const response = await this.fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      throw new Error(`slack ${method} HTTP ${response.status} ${response.statusText}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`malformed_slack_response: ${method} returned invalid JSON`);
    }
    const record = recordOf(body, method);
    if (record["ok"] !== true) {
      const error =
        typeof record["error"] === "string" && record["error"].trim() !== "" ? record["error"] : "unknown_error";
      throw new Error(`slack ${method} failed: ${error}`);
    }
    return record;
  }
}

function parseChannel(value: unknown, context: string): SlackProductChannel {
  const channel = recordOf(value, context);
  const isMember = channel["is_member"];
  if (typeof isMember !== "boolean") {
    throw new TypeError(`malformed_slack_channel: ${context}.is_member is missing or wrong-type`);
  }
  return {
    id: requiredNonBlankString(channel["id"], `${context}.id`),
    name: requiredNonBlankString(channel["name"], `${context}.name`),
    isMember,
  };
}

function parseNextCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const metadata = recordOf(value, "conversations.list.response_metadata");
  const cursor = metadata["next_cursor"];
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "string") {
    throw new TypeError("malformed_slack_cursor: conversations.list.response_metadata.next_cursor is wrong-type");
  }
  return cursor;
}

function requiredNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`malformed_slack_response: ${field} is missing, blank, or wrong-type`);
  }
  return value;
}

function recordOf(value: unknown, context: string): SlackRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`malformed_slack_response: ${context} returned no object`);
  }
  return value as SlackRecord;
}
