import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";

// Microsoft Teams channel — incoming-webhook delivery.
//
// Target shape:
//   - `destination` is a *credential ref* pointing at the Teams incoming
//     webhook URL (a write-only secret resolved through the secret store). The
//     webhook URL is NEVER stored in the clear on the target row; the matrix UI
//     persists a `credential/...` ref and the operator writes the secret
//     separately.
//
// Delivery model: POST a legacy MessageCard JSON body (the shape connector
// webhooks accept without an Adaptive Card wrapper) to the resolved URL.
// Teams returns `200` with body `1` on success; any non-2xx is surfaced as a
// thrown Error which the dispatcher catches and records as `status='failed'`.

export interface TeamsChannelDeps {
  // Secret store used to resolve a webhook credential ref into the actual
  // Teams incoming-webhook URL. REQUIRED — a credential ref is the only
  // accepted destination shape.
  secrets: SecretStore;
  // fetch is injected so tests can drive it without a real network.
  fetch?: typeof fetch;
}

// MessageCard themeColor is a hex string (no `#`). Maps severity to a hue.
const TEAMS_THEME_BY_SEVERITY: Record<NotificationPayload["severity"], string> = {
  ok: "2EB67D",
  info: "1264A3",
  warn: "ECB22E",
  fail: "E01E5A",
};

export class TeamsChannel implements NotificationChannel {
  readonly kind = "teams" as const;
  readonly wired = true;
  private readonly secrets: SecretStore;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: TeamsChannelDeps) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const url = await resolveWebhookUrl("teams", this.secrets, target.destination);
    const body = JSON.stringify(buildTeamsCard(payload));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`teams publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }
}

interface TeamsMessageCard {
  "@type": "MessageCard";
  "@context": "http://schema.org/extensions";
  themeColor: string;
  summary: string;
  title: string;
  text: string;
  sections: Array<{ facts: Array<{ name: string; value: string }> }>;
  potentialAction?: Array<{
    "@type": "OpenUri";
    name: string;
    targets: Array<{ os: "default"; uri: string }>;
  }>;
}

function buildTeamsCard(payload: NotificationPayload): TeamsMessageCard {
  const facts: Array<{ name: string; value: string }> = [
    { name: "event", value: payload.eventName },
    { name: "severity", value: payload.severity },
  ];
  if (payload.tags !== undefined && payload.tags.length > 0) {
    facts.push({ name: "tags", value: payload.tags.join(", ") });
  }
  const card: TeamsMessageCard = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: TEAMS_THEME_BY_SEVERITY[payload.severity],
    summary: payload.title,
    title: payload.title,
    text: payload.body,
    sections: [{ facts }],
  };
  if (payload.url !== undefined) {
    card.potentialAction = [
      {
        "@type": "OpenUri",
        name: "view run",
        targets: [{ os: "default", uri: payload.url }],
      },
    ];
  }
  return card;
}

// Shared webhook resolution: the destination is ALWAYS a credential ref
// resolved through the secret store (the webhook URL is never stored in the
// clear on the target row).
export async function resolveWebhookUrl(channel: string, secrets: SecretStore, destination: string): Promise<string> {
  const secret = await secrets.get(destination);
  if (secret === undefined) {
    throw new Error(`missing ${channel} webhook credential ref: ${destination}`);
  }
  return secret.value;
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
