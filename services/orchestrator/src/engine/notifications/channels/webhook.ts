import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";
import { resolveWebhookUrl, safeReadText } from "./teams.js";

// Generic webhook channel — POSTs the raw notification payload as JSON.
//
// Target shape:
//   - `destination` is a *credential ref* pointing at the destination URL (a
//     write-only secret resolved through the secret store). For dev /
//     back-compat a destination that is already a full `https://...` URL is
//     used verbatim.
//
// Delivery model: POST the redacted NotificationPayload verbatim as the JSON
// body so downstream consumers receive the canonical event shape. Any non-2xx
// is surfaced as a thrown Error which the dispatcher catches and records as
// `status='failed'`.

export interface WebhookChannelDeps {
  // Secret store used to resolve a destination credential ref into the actual
  // URL. Optional only for the legacy verbatim-URL path.
  secrets?: SecretStore;
  // fetch is injected so tests can drive it without a real network.
  fetch?: typeof fetch;
}

export class WebhookChannel implements NotificationChannel {
  readonly kind = "webhook" as const;
  readonly wired = true;
  private readonly secrets: SecretStore | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: WebhookChannelDeps = {}) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const url = await resolveWebhookUrl("webhook", this.secrets, target.destination);
    // The generic webhook receives the canonical payload shape verbatim:
    // title/body/severity/eventName plus optional url/tags.
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      severity: payload.severity,
      eventName: payload.eventName,
      ...(payload.url === undefined ? {} : { url: payload.url }),
      ...(payload.tags === undefined ? {} : { tags: payload.tags }),
    });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`webhook publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }
}
