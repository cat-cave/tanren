import type { SecretStore } from "../../contracts/secretStore.js";
import { signWebhookBody } from "../../webhooks/hmacSignature.js";
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
//
// Signing (P-INT-6): each target gets a per-target signing secret resolved from
// the secret store at `<signingRefPrefix>/<targetId>` (default
// `credential/webhook-signing/<targetId>`). When the store holds that secret we
// HMAC-SHA256 the body and send the digest as `X-Tanren-Signature: sha256=<hex>`
// plus an `X-Tanren-Timestamp` header (the timestamp is bound into the digest, a
// replay guard) — a provisioned webhook target SHOULD carry one. Sign-if-
// configured is the explicit fallback: a target with no signing secret (no store,
// or no value at the ref) is delivered UNSIGNED rather than failing — the
// destination URL still gates delivery. The secret VALUE is never logged or
// surfaced; only the public digest crosses the wire.

/** Default prefix for the per-target signing-secret ref (`<prefix>/<targetId>`). */
const DEFAULT_SIGNING_REF_PREFIX = "credential/webhook-signing";

export interface WebhookChannelDeps {
  // Secret store used to resolve a destination credential ref into the actual
  // URL, AND the per-target signing secret. Optional only for the legacy
  // verbatim-URL path; without it a target cannot be signed (unsigned fallback).
  secrets?: SecretStore;
  // Override the per-target signing-secret ref prefix; the resolved ref is
  // `<prefix>/<targetId>`. Defaults to `credential/webhook-signing`.
  signingRefPrefix?: string;
  // Injectable clock (unix ms) for the signature timestamp; defaults to Date.now.
  nowMs?: () => number;
  // fetch is injected so tests can drive it without a real network.
  fetch?: typeof fetch;
}

export class WebhookChannel implements NotificationChannel {
  readonly kind = "webhook" as const;
  readonly wired = true;
  private readonly secrets: SecretStore | undefined;
  private readonly signingRefPrefix: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: WebhookChannelDeps = {}) {
    this.secrets = deps.secrets;
    this.signingRefPrefix = deps.signingRefPrefix ?? DEFAULT_SIGNING_REF_PREFIX;
    this.now = deps.nowMs ?? Date.now;
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
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Sign-if-configured: resolve the per-target signing secret; sign the body
    // (binding the timestamp) only when a secret value is present.
    const signingSecret = await this.resolveSigningSecret(target.id);
    if (signingSecret !== undefined) {
      const { signature, timestamp } = signWebhookBody({ body, secret: signingSecret, nowMs: this.now() });
      headers["X-Tanren-Signature"] = signature;
      headers["X-Tanren-Timestamp"] = timestamp;
    }
    const response = await this.fetchImpl(url, { method: "POST", headers, body });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`webhook publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }

  /** Resolve the per-target signing secret value, or undefined when unconfigured. */
  private async resolveSigningSecret(targetId: string): Promise<string | undefined> {
    if (this.secrets === undefined) return undefined;
    const ref = `${this.signingRefPrefix}/${targetId}`;
    const secret = await this.secrets.get(ref);
    return secret?.value;
  }
}
