// The injectable HTTP transport for the Slack Web API, scoped to exactly the
// calls the SlackProvisioner needs: list/find/create a channel and ensure the
// bot is a member. NO real Slack call lives in CI — tests drive the provisioner
// against a SCRIPTED transport implementing this same interface. Production wires
// {@link FetchSlackApiTransport}, which talks to `https://slack.com/api/*` with
// the org bot token (resolved from the grant's credential ref against the
// SecretStore — the token never lands in a provisioned artifact in the clear).
//
// Plane A ONLY: this is the transport for Tanren's OWN Slack notification
// provisioning (the Forge interaction plane). The built product's own Slack bot is
// Plane B (the built product's app environment) and is provisioned separately.
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING — task #32,
// critic-arc R1 #3 / R2): the 429 (rate-limit) retry path is UNBOUNDED and waits the
// SERVER-supplied `Retry-After`. There is NO attempt count and NO header CLAMP — Slack's
// `Retry-After` IS the authoritative external constraint; clamping it just generates more
// 429s. Repeated throttling remains pending/retryable until Slack supplies a non-429
// response or an operator stops the owning workflow.

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
 * A typed 429 surfaced by {@link FetchSlackApiTransport.call} that the convergence-based
 * retry helper recognizes as transient. Carries the server-supplied wait so the retry
 * wrapper honors Slack's `Retry-After` verbatim (no clamp — Slack IS the authority).
 */
export class SlackRateLimited extends Error {
  readonly retryAfterMs: number;

  constructor(waitMs: number) {
    super(`slack rate-limited: server requested ${waitMs}ms wait before retry`);
    this.name = "SlackRateLimited";
    this.retryAfterMs = waitMs;
  }
}

export interface Slack429RetryOptions {
  /** Override the sleep (tests inject a no-wait sleep). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `operation`, retrying ONLY a typed {@link SlackRateLimited} (a 429) UNBOUNDED.
 * Backoff = the server-supplied `retryAfterMs` (NOT a fixed curve — Slack tells us when
 * to come back, verbatim, no clamp). Any other thrown error is re-thrown immediately —
 * never treated as transient.
 */
export async function withSlack429Retry<T>(
  operation: () => Promise<T>,
  options: Slack429RetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep429Sleep;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SlackRateLimited)) {
        throw error;
      }
      // Honor the server-supplied wait verbatim — no clamp. Slack's Retry-After IS the
      // authoritative external constraint; clamping just generates more 429s.
      await sleep(error.retryAfterMs);
    }
  }
}

function defaultSleep429Sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // arch-allow: timeout-class — server-directed Retry-After SPACING (cadence, not a deadline).
    setTimeout(resolve, ms);
  });
}

export class FetchSlackApiTransport implements SlackApiTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly tokenForAttempt: () => Promise<string>,
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
  // status: this layer throws a typed {@link SlackRateLimited} carrying the server-supplied
  // `Retry-After`, and the surrounding {@link withSlack429Retry} wrapper retries UNBOUNDED
  // (no count) on the server-directed cadence. A sustained 429 remains pending rather than
  // being falsely classified as provider success or a terminal product failure.
  private async call<T extends SlackApiEnvelope>(method: string, params: Record<string, string>): Promise<T> {
    return await withSlack429Retry(
      async () => {
        const botToken = await this.tokenForAttempt();
        const response = await this.fetchImpl(`${SLACK_API_BASE}/${method}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Bearer ${botToken}`,
          },
          body: new URLSearchParams(params).toString(),
        });
        if (response.status === 429) {
          throw new SlackRateLimited(retryAfterMs(response.headers.get("retry-after")));
        }
        if (!response.ok) {
          throw new Error(`slack ${method} HTTP ${response.status} ${response.statusText}`);
        }
        const body = (await response.json()) as T;
        if (!body.ok) {
          throw new Error(`slack ${method} failed: ${body.error ?? "unknown_error"}`);
        }
        return body;
      },
      { sleep: this.sleep },
    );
  }
}

/**
 * Parse a Slack `Retry-After` header (seconds) into a millisecond wait. A missing or
 * unparseable header falls back to 1s. The value is honored VERBATIM — there is NO clamp
 * (task #32: Slack's Retry-After IS the authoritative external constraint; a clamp at this
 * layer just generates more 429s).
 */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
}
