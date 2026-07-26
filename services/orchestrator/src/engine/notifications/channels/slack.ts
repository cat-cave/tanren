// cspell:ignore xoxb xoxp xoxa xoxr xapp xoxe
import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";
import { decodeSlackBotDestination } from "./slackBotDestination.js";

// Slack channel — second wired channel after ntfy.
//
// Target shape:
//   - `destination` is a *credential ref* pointing at the Slack incoming
//     webhook URL (a write-only secret). We never store the webhook URL in
//     the clear on the target row: the matrix UI persists a `credential/...`
//     ref and the operator writes the secret separately.
//
// Delivery model: POST the standard Slack incoming-webhook JSON body
// (`{ text, blocks }`) to the resolved URL. Slack returns `200 ok` on success
// and a non-2xx with a plain-text reason otherwise; we surface failures as a
// thrown Error which the dispatcher catches and records as `status='failed'`.

export interface SlackChannelDeps {
  // Secret store used to resolve a webhook credential ref into the actual
  // Slack incoming-webhook URL. REQUIRED — a credential ref is the only
  // accepted destination shape.
  secrets: SecretStore;
  // fetch is injected so tests can drive it without a real network. The
  // default is the global fetch in Node 20+.
  fetch?: typeof fetch;
}

const SLACK_EMOJI_BY_SEVERITY: Record<NotificationPayload["severity"], string> = {
  ok: ":white_check_mark:",
  info: ":information_source:",
  warn: ":warning:",
  fail: ":rotating_light:",
};

export class SlackChannel implements NotificationChannel {
  readonly kind = "slack" as const;
  readonly wired = true;
  private readonly secrets: SecretStore;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: SlackChannelDeps) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const botTarget = decodeSlackBotDestination(target.destination);
    if (botTarget !== undefined) {
      await this.publishWithBot(botTarget, payload);
      return;
    }
    const url = await this.resolveWebhookUrl(target.destination);
    const body = JSON.stringify(buildSlackMessage(payload));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`slack publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }

  private async publishWithBot(
    target: { botTokenRef: string; channelId: string },
    payload: NotificationPayload,
  ): Promise<void> {
    const secret = await this.secrets.get(target.botTokenRef);
    if (secret === undefined) {
      throw new Error(`missing Slack bot credential ref: ${target.botTokenRef}`);
    }
    assertBotToken(secret.value);
    const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret.value}` },
      body: JSON.stringify({ channel: target.channelId, ...buildSlackMessage(payload) }),
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`slack bot publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
    const body = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (body?.ok !== true) {
      const detail = typeof body?.error === "string" ? body.error : "malformed_slack_response";
      throw new Error(`slack bot publish failed: ${detail}`);
    }
  }

  // The destination is ALWAYS a credential ref resolved through the secret
  // store (the webhook URL is never stored in the clear on the target row).
  // The resolved value MUST be an incoming-webhook URL — a bot/app token
  // (`xoxb-…`, the chat.postMessage credential model) is rejected loudly rather
  // than POSTed as if it were a webhook (which would leak Slack's secret to a
  // non-URL and never deliver).
  private async resolveWebhookUrl(destination: string): Promise<string> {
    const secret = await this.secrets.get(destination);
    if (secret === undefined) {
      throw new Error(`missing Slack webhook credential ref: ${destination}`);
    }
    assertIncomingWebhookUrl(secret.value);
    return secret.value;
  }
}

// Slack bot/user/app/refresh token prefixes. The runtime Slack channel is an
// INCOMING-WEBHOOK publisher — it POSTs the message body to a webhook URL. A
// resolved token is a different credential model; POSTing to it is a category
// error, so it fails closed here (the negative control for the provisioner ↔
// channel contract: a bot token is never POSTed as a webhook).
const SLACK_TOKEN_PREFIXES = ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xapp-", "xoxe-"];

function assertBotToken(value: string): void {
  if (!value.startsWith("xoxb-")) {
    throw new Error("resolved Slack bot credential is not an xoxb bot token");
  }
}

function assertIncomingWebhookUrl(value: string): void {
  if (SLACK_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new Error(
      "resolved Slack destination is a bot/app token, not an incoming-webhook URL — refusing to POST a token as a webhook",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("resolved Slack destination is not a valid incoming-webhook URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`resolved Slack destination must be an https incoming-webhook URL (got ${parsed.protocol})`);
  }
}

interface SlackMessage {
  text: string;
  blocks: unknown[];
}

function buildSlackMessage(payload: NotificationPayload): SlackMessage {
  const emoji = SLACK_EMOJI_BY_SEVERITY[payload.severity];
  const headerText = `${emoji} ${payload.title}`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: truncate(headerText, 150) } },
    { type: "section", text: { type: "mrkdwn", text: codeBlock(payload.body) } },
  ];
  const contextElements = [`*event* ${payload.eventName}`, `*severity* ${payload.severity}`];
  if (payload.tags !== undefined && payload.tags.length > 0) {
    contextElements.push(payload.tags.join(" · "));
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: contextElements.join("  |  ") }],
  });
  if (payload.url !== undefined) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "view run" },
          url: payload.url,
        },
      ],
    });
  }
  // `text` is the fallback/notification summary Slack shows in the sidebar.
  return { text: headerText, blocks };
}

function codeBlock(body: string): string {
  // Slack mrkdwn caps a single text object at 3000 chars; keep headroom for
  // the fence markers.
  return "```" + truncate(body, 2900) + "```";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
