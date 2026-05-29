import type { SecretStore } from "../../contracts/secretStore.js";
import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";
import { safeReadText } from "./teams.js";

// Email channel — delivery through an injectable EmailTransport port.
//
// Target shape:
//   - `destination` is the recipient email address.
//
// Transport: the channel does not hard-code SMTP vs. an HTTP email API. It
// depends on an `EmailTransport` port whose single `send` method tests mock
// and which production wires to a concrete transport (SMTP relay or an HTTP
// email API such as SendGrid/Mailgun). A default `HttpEmailTransport` is
// provided that POSTs to an HTTP email API whose endpoint + API key are read
// from the secret store (write-only).
//
// Failures are surfaced as a thrown Error which the dispatcher catches and
// records as `status='failed'`.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

// Port: production supplies SMTP or an HTTP email API; tests supply a mock.
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailChannelDeps {
  // The transport port. When omitted the channel falls back to the
  // HttpEmailTransport built from `apiEndpointRef` / `apiKeyRef` + secrets.
  transport?: EmailTransport;
  // Secret store used by the default HttpEmailTransport to resolve the API
  // endpoint URL and API key (both write-only).
  secrets?: SecretStore;
  fetch?: typeof fetch;
  // Credential refs the default transport resolves. Optional; supplying a
  // `transport` directly bypasses these.
  apiEndpointRef?: string;
  apiKeyRef?: string;
  // Optional From address the default transport stamps on outgoing mail.
  from?: string;
}

export class EmailChannel implements NotificationChannel {
  readonly kind = "email" as const;
  readonly wired = true;
  private readonly transport: EmailTransport;

  constructor(deps: EmailChannelDeps = {}) {
    this.transport =
      deps.transport ??
      new HttpEmailTransport({
        secrets: deps.secrets,
        fetch: deps.fetch,
        apiEndpointRef: deps.apiEndpointRef,
        apiKeyRef: deps.apiKeyRef,
        from: deps.from,
      });
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    await this.transport.send({
      to: target.destination,
      subject: payload.title,
      text: buildEmailBody(payload),
    });
  }
}

function buildEmailBody(payload: NotificationPayload): string {
  const lines = [payload.body, "", `event: ${payload.eventName}`, `severity: ${payload.severity}`];
  if (payload.tags !== undefined && payload.tags.length > 0) {
    lines.push(`tags: ${payload.tags.join(", ")}`);
  }
  if (payload.url !== undefined) {
    lines.push(`url: ${payload.url}`);
  }
  return lines.join("\n");
}

interface HttpEmailTransportDeps {
  secrets?: SecretStore | undefined;
  fetch?: typeof fetch | undefined;
  apiEndpointRef?: string | undefined;
  apiKeyRef?: string | undefined;
  from?: string | undefined;
}

// Default transport: POSTs a `{ from, to, subject, text }` JSON body to an
// HTTP email API. Endpoint + API key are write-only secrets resolved at send
// time so they never live on the target row.
export class HttpEmailTransport implements EmailTransport {
  private readonly secrets: SecretStore | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly apiEndpointRef: string;
  private readonly apiKeyRef: string;
  private readonly from: string;

  constructor(deps: HttpEmailTransportDeps = {}) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch ?? fetch;
    this.apiEndpointRef = deps.apiEndpointRef ?? "credential/email/api-endpoint";
    this.apiKeyRef = deps.apiKeyRef ?? "credential/email/api-key";
    this.from = deps.from ?? "tanren@localhost";
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.secrets === undefined) {
      throw new Error("email channel needs a secret store to resolve API credentials");
    }
    const endpoint = await this.secrets.get(this.apiEndpointRef);
    if (endpoint === undefined) {
      throw new Error(`missing email API endpoint credential ref: ${this.apiEndpointRef}`);
    }
    const apiKey = await this.secrets.get(this.apiKeyRef);
    if (apiKey === undefined) {
      throw new Error(`missing email API key credential ref: ${this.apiKeyRef}`);
    }
    const response = await this.fetchImpl(endpoint.value, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.value}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`email publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }
}
