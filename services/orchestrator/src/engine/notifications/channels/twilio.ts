import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";
import { safeReadText } from "./teams.js";

// Twilio SMS channel — delivery through the Twilio REST API.
//
// Target shape:
//   - `destination` is the recipient phone number in E.164 form
//     (`+15551234567`).
//
// Auth: the account SID, auth token, and From number are write-only secrets
// resolved from the secret store at send time (HTTP Basic with the SID as the
// username and the auth token as the password). The channel POSTs a
// `application/x-www-form-urlencoded` body to the Messages resource.
//
// Failures are surfaced as a thrown Error which the dispatcher catches and
// records as `status='failed'`.

export interface TwilioChannelDeps {
  // Secret store the channel resolves the SID / token / From number from.
  // Required: without it the channel cannot authenticate.
  secrets?: SecretStore;
  fetch?: typeof fetch;
  // Credential refs (write-only). Defaults follow the `credential/twilio/*`
  // convention.
  accountSidRef?: string;
  authTokenRef?: string;
  fromNumberRef?: string;
  // API base; injectable for tests. Defaults to the public Twilio API.
  apiBaseUrl?: string;
}

export class TwilioChannel implements NotificationChannel {
  readonly kind = "twilio" as const;
  readonly wired = true;
  private readonly secrets: SecretStore | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly accountSidRef: string;
  private readonly authTokenRef: string;
  private readonly fromNumberRef: string;
  private readonly apiBaseUrl: string;

  constructor(deps: TwilioChannelDeps = {}) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
    this.accountSidRef = deps.accountSidRef ?? "credential/twilio/account-sid";
    this.authTokenRef = deps.authTokenRef ?? "credential/twilio/auth-token";
    this.fromNumberRef = deps.fromNumberRef ?? "credential/twilio/from-number";
    this.apiBaseUrl = deps.apiBaseUrl ?? "https://api.twilio.com";
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    if (this.secrets === undefined) {
      throw new Error("twilio channel needs a secret store to resolve credentials");
    }
    const accountSid = await this.requireSecret(this.accountSidRef);
    const authToken = await this.requireSecret(this.authTokenRef);
    const fromNumber = await this.requireSecret(this.fromNumberRef);

    const base = this.apiBaseUrl.endsWith("/") ? this.apiBaseUrl.slice(0, -1) : this.apiBaseUrl;
    const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const form = new URLSearchParams({
      To: target.destination,
      From: fromNumber,
      Body: buildSmsBody(payload)
    });
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`
      },
      body: form.toString()
    });
    // Twilio returns 201 Created on a queued message.
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(
        `twilio publish failed: ${response.status} ${response.statusText} ${detail}`.trim()
      );
    }
  }

  private async requireSecret(ref: string): Promise<string> {
    const secret = await this.secrets?.get(ref);
    if (secret === undefined) {
      throw new Error(`missing twilio credential ref: ${ref}`);
    }
    return secret.value;
  }
}

function buildSmsBody(payload: NotificationPayload): string {
  // SMS is plain text; keep it terse. Twilio splits long bodies into segments,
  // but cap to one logical message worth of context.
  const head = `[${payload.severity.toUpperCase()}] ${payload.title}`;
  const body = payload.body.length > 0 ? `\n${payload.body}` : "";
  const link = payload.url !== undefined ? `\n${payload.url}` : "";
  return truncate(`${head}${body}${link}`, 1500);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
