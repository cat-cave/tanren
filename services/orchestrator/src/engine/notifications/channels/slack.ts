import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";

// P3-0024 Slack channel — second wired channel after ntfy.
//
// Target shape:
//   - `destination` is a *credential ref* pointing at the Slack incoming
//     webhook URL (a write-only secret). We never store the webhook URL in
//     the clear on the target row: the matrix UI persists a `credential/...`
//     ref and the operator writes the secret separately. For dev / back-compat
//     a destination that is already a full `https://hooks.slack.com/...` URL is
//     used verbatim.
//
// Delivery model: POST the standard Slack incoming-webhook JSON body
// (`{ text, blocks }`) to the resolved URL. Slack returns `200 ok` on success
// and a non-2xx with a plain-text reason otherwise; we surface failures as a
// thrown Error which the dispatcher catches and records as `status='failed'`.

export interface SlackChannelDeps {
  // Secret store used to resolve a webhook credential ref into the actual
  // Slack incoming-webhook URL. Required when targets store a credential ref
  // (the recommended write-only model). Optional only for the legacy
  // verbatim-URL path.
  secrets?: SecretStore;
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
  private readonly secrets: SecretStore | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: SlackChannelDeps = {}) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
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

  // A destination that already looks like a webhook URL is used as-is; anything
  // else is treated as a credential ref and resolved through the secret store.
  private async resolveWebhookUrl(destination: string): Promise<string> {
    if (destination.startsWith("https://") || destination.startsWith("http://")) {
      return destination;
    }
    if (this.secrets === undefined) {
      throw new Error(`slack channel needs a secret store to resolve credential ref: ${destination}`);
    }
    const secret = await this.secrets.get(destination);
    if (secret === undefined) {
      throw new Error(`missing Slack webhook credential ref: ${destination}`);
    }
    return secret.value;
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
