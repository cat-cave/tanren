import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";
import { resolveWebhookUrl, safeReadText } from "./teams.js";

// Discord channel — incoming-webhook delivery.
//
// Target shape:
//   - `destination` is a *credential ref* pointing at the Discord webhook URL
//     (a write-only secret resolved through the secret store). For dev /
//     back-compat a destination that is already a full
//     `https://discord.com/api/webhooks/...` URL is used verbatim.
//
// Delivery model: POST a `{ content, embeds }` JSON body to the resolved URL.
// Discord returns `204 No Content` on success; any non-2xx is surfaced as a
// thrown Error which the dispatcher catches and records as `status='failed'`.

export interface DiscordChannelDeps {
  // Secret store used to resolve a webhook credential ref into the actual
  // Discord webhook URL. Optional only for the legacy verbatim-URL path.
  secrets?: SecretStore;
  // fetch is injected so tests can drive it without a real network.
  fetch?: typeof fetch;
}

// Discord embed `color` is a decimal RGB integer. Maps severity to a hue.
const DISCORD_COLOR_BY_SEVERITY: Record<NotificationPayload["severity"], number> = {
  ok: 0x2eb67d,
  info: 0x1264a3,
  warn: 0xecb22e,
  fail: 0xe01e5a
};

export class DiscordChannel implements NotificationChannel {
  readonly kind = "discord" as const;
  readonly wired = true;
  private readonly secrets: SecretStore | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: DiscordChannelDeps = {}) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const url = await resolveWebhookUrl("discord", this.secrets, target.destination);
    const body = JSON.stringify(buildDiscordMessage(payload));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(
        `discord publish failed: ${response.status} ${response.statusText} ${detail}`.trim()
      );
    }
  }
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  url?: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
}

interface DiscordMessage {
  content: string;
  embeds: DiscordEmbed[];
}

function buildDiscordMessage(payload: NotificationPayload): DiscordMessage {
  const fields: DiscordEmbed["fields"] = [
    { name: "event", value: payload.eventName, inline: true },
    { name: "severity", value: payload.severity, inline: true }
  ];
  if (payload.tags !== undefined && payload.tags.length > 0) {
    fields.push({ name: "tags", value: payload.tags.join(", "), inline: false });
  }
  const embed: DiscordEmbed = {
    title: truncate(payload.title, 256),
    // Discord embed descriptions cap at 4096 chars.
    description: truncate(payload.body, 4096),
    color: DISCORD_COLOR_BY_SEVERITY[payload.severity],
    fields
  };
  if (payload.url !== undefined) {
    embed.url = payload.url;
  }
  // `content` is the plain-text line Discord shows above the embed (caps at
  // 2000 chars).
  return { content: truncate(payload.title, 2000), embeds: [embed] };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
