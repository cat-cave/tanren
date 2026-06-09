// The injectable HTTP transport for the Slack Web API, scoped to exactly the
// calls the SlackProvisioner needs: list/find/create a channel and ensure the
// bot is a member. NO real Slack call lives in CI — tests drive the provisioner
// against a SCRIPTED transport implementing this same interface. Production wires
// {@link FetchSlackApiTransport}, which talks to `https://slack.com/api/*` with
// the org bot token (resolved from the grant's credential ref against the
// SecretStore — the token never lands in a provisioned artifact in the clear).
//
// Plane A ONLY: this is the transport for Tanren's OWN Slack notification
// provisioning (the Forge interaction plane). The apex product's own Slack bot is
// Plane B (the built product's app environment) and is provisioned separately.

const SLACK_API_BASE = "https://slack.com/api";

/** A Slack conversation (channel) as the provisioner cares about it. */
export interface SlackConversation {
  id: string;
  name: string;
  /** Whether the bot identity is already a member (drives the join step). */
  isMember: boolean;
}

export interface ListConversationsInput {
  /** Slack cursor pagination token; absent on the first page. */
  cursor?: string;
  /** Conversation types to include, e.g. "public_channel,private_channel". */
  types?: string;
}

export interface ListConversationsResult {
  channels: SlackConversation[];
  /** The next-page cursor; empty string / undefined when exhausted. */
  nextCursor?: string;
}

export interface CreateConversationInput {
  name: string;
  isPrivate?: boolean;
}

/**
 * The minimal Slack Web API surface the provisioner exercises. Every method runs
 * under the org bot token supplied at construction. A scripted fake implementing
 * this interface is what the conformance suite drives — no network in CI.
 */
export interface SlackApiTransport {
  /** `auth.test` — resolve the bot's own user id (used for membership checks). */
  authTest(): Promise<{ botUserId: string }>;
  /** `conversations.list` — one page of the workspace's channels. */
  listConversations(input: ListConversationsInput): Promise<ListConversationsResult>;
  /** `conversations.create` — create a channel; rejects if Slack returns an error. */
  createConversation(input: CreateConversationInput): Promise<SlackConversation>;
  /** `conversations.join` — ensure the bot is a member of the channel. */
  joinConversation(channelId: string): Promise<void>;
}

interface SlackApiEnvelope {
  ok: boolean;
  error?: string;
}

interface SlackAuthTestResponse extends SlackApiEnvelope {
  user_id?: string;
}

interface SlackChannelObject {
  id: string;
  name: string;
  is_member?: boolean;
}

interface SlackListResponse extends SlackApiEnvelope {
  channels?: SlackChannelObject[];
  response_metadata?: { next_cursor?: string };
}

interface SlackCreateResponse extends SlackApiEnvelope {
  channel?: SlackChannelObject;
}

function toConversation(channel: SlackChannelObject): SlackConversation {
  return { id: channel.id, name: channel.name, isMember: channel.is_member ?? false };
}

/**
 * Production Slack transport over `fetch`. The bot token is passed as a resolved
 * value (the caller resolves the grant's credential ref against the SecretStore);
 * it is sent only as the `Authorization: Bearer` header and is never returned to
 * the provisioner or embedded in any artifact.
 */
// How many times a 429 (Slack rate-limit) is retried before surfacing the error.
// Slack returns a `Retry-After` (seconds) header on a 429; we honor it (bounded) so a
// burst of channel calls rides out a transient rate-limit rather than failing the
// provision. Bounded so a persistent 429 still fails LOUD rather than retrying forever.
const SLACK_MAX_RATE_LIMIT_RETRIES = 3;
// A defensive cap on the honored `Retry-After` so a hostile/huge header cannot wedge a
// run; Slack's real values are single-digit seconds.
const SLACK_MAX_RETRY_AFTER_MS = 60_000;

export class FetchSlackApiTransport implements SlackApiTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly botToken: string,
    fetchImpl?: typeof fetch,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.sleep =
      sleep ??
      ((ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async authTest(): Promise<{ botUserId: string }> {
    const body = await this.call<SlackAuthTestResponse>("auth.test", {});
    if (typeof body.user_id !== "string") {
      throw new TypeError("slack auth.test returned no user_id");
    }
    return { botUserId: body.user_id };
  }

  async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
    const params: Record<string, string> = {
      limit: "200",
      exclude_archived: "true",
      types: input.types ?? "public_channel,private_channel",
    };
    if (input.cursor !== undefined && input.cursor.length > 0) {
      params["cursor"] = input.cursor;
    }
    const body = await this.call<SlackListResponse>("conversations.list", params);
    return {
      channels: (body.channels ?? []).map((channel) => toConversation(channel)),
      nextCursor: body.response_metadata?.next_cursor,
    };
  }

  async createConversation(input: CreateConversationInput): Promise<SlackConversation> {
    const body = await this.call<SlackCreateResponse>("conversations.create", {
      name: input.name,
      is_private: input.isPrivate === true ? "true" : "false",
    });
    if (body.channel === undefined) {
      throw new Error("slack conversations.create returned no channel");
    }
    return toConversation(body.channel);
  }

  async joinConversation(channelId: string): Promise<void> {
    await this.call("conversations.join", { channel: channelId });
  }

  // Every Slack Web API call returns 200 with an `{ ok, error }` envelope; a
  // non-ok envelope is a real failure we surface as a thrown Error (the provider
  // never silently swallows a Slack error). A 429 (rate-limit) is the one retryable
  // status: Slack supplies a `Retry-After` (seconds) header we honor (bounded) before
  // retrying, up to {@link SLACK_MAX_RATE_LIMIT_RETRIES}; a persistent 429 then fails LOUD.
  private async call<T extends SlackApiEnvelope>(method: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${SLACK_API_BASE}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${this.botToken}`,
        },
        body: new URLSearchParams(params).toString(),
      });
      if (response.status === 429 && attempt < SLACK_MAX_RATE_LIMIT_RETRIES) {
        await this.sleep(retryAfterMs(response.headers.get("retry-after")));
        continue;
      }
      if (!response.ok) {
        throw new Error(`slack ${method} HTTP ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as T;
      if (!body.ok) {
        throw new Error(`slack ${method} failed: ${body.error ?? "unknown_error"}`);
      }
      return body;
    }
  }
}

/**
 * Parse a Slack `Retry-After` header (seconds) into a bounded millisecond wait. A
 * missing/unparseable header falls back to 1s; the value is capped at
 * {@link SLACK_MAX_RETRY_AFTER_MS} so a hostile/huge header cannot wedge a run.
 */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number.parseInt(header, 10);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
  return Math.min(ms, SLACK_MAX_RETRY_AFTER_MS);
}
