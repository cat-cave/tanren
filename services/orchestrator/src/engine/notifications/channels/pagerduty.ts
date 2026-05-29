import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";
import { safeReadText } from "./teams.js";

// PagerDuty channel — delivery through the Events API v2.
//
// Target shape:
//   - `destination` is a *credential ref* pointing at the integration routing
//     key (a write-only secret resolved through the secret store). For dev /
//     back-compat a 32-char routing key passed verbatim is used as-is.
//
// Delivery model: POST a `trigger` event to the Events API v2 enqueue
// endpoint. Severity maps onto PagerDuty's critical/error/warning/info scale.
// PagerDuty returns `202 Accepted` on success; any non-2xx is surfaced as a
// thrown Error which the dispatcher catches and records as `status='failed'`.

export interface PagerDutyChannelDeps {
  // Secret store used to resolve a routing-key credential ref. Optional only
  // for the legacy verbatim-key path.
  secrets?: SecretStore;
  fetch?: typeof fetch;
  // Events API base; injectable for tests. Defaults to the public endpoint.
  apiBaseUrl?: string;
}

// PagerDuty Events API v2 `severity` enum.
const PD_SEVERITY_BY_SEVERITY: Record<NotificationPayload["severity"], string> = {
  ok: "info",
  info: "info",
  warn: "warning",
  fail: "critical",
};

export class PagerDutyChannel implements NotificationChannel {
  readonly kind = "pagerduty" as const;
  readonly wired = true;
  private readonly secrets: SecretStore | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(deps: PagerDutyChannelDeps = {}) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
    this.apiBaseUrl = deps.apiBaseUrl ?? "https://events.pagerduty.com";
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const routingKey = await this.resolveRoutingKey(target.destination);
    const base = this.apiBaseUrl.endsWith("/") ? this.apiBaseUrl.slice(0, -1) : this.apiBaseUrl;
    const url = `${base}/v2/enqueue`;
    const body = JSON.stringify(buildEvent(routingKey, payload));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.status !== 202) {
      const detail = await safeReadText(response);
      throw new Error(`pagerduty publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }

  // A destination shaped like a credential ref is resolved through the secret
  // store; anything else (a bare routing key) is used verbatim.
  private async resolveRoutingKey(destination: string): Promise<string> {
    if (!destination.includes("/")) {
      return destination;
    }
    if (this.secrets === undefined) {
      throw new Error(`pagerduty channel needs a secret store to resolve credential ref: ${destination}`);
    }
    const secret = await this.secrets.get(destination);
    if (secret === undefined) {
      throw new Error(`missing pagerduty routing-key credential ref: ${destination}`);
    }
    return secret.value;
  }
}

interface PagerDutyEvent {
  routing_key: string;
  event_action: "trigger";
  payload: {
    summary: string;
    source: string;
    severity: string;
    custom_details: { body: string; tags?: string[] };
  };
  client?: string;
  client_url?: string;
}

function buildEvent(routingKey: string, payload: NotificationPayload): PagerDutyEvent {
  const event: PagerDutyEvent = {
    routing_key: routingKey,
    event_action: "trigger",
    payload: {
      // `summary` caps at 1024 chars in the Events API.
      summary: truncate(payload.title, 1024),
      source: payload.eventName,
      severity: PD_SEVERITY_BY_SEVERITY[payload.severity],
      custom_details: {
        body: payload.body,
        ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      },
    },
  };
  if (payload.url !== undefined) {
    event.client = "tanren";
    event.client_url = payload.url;
  }
  return event;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
