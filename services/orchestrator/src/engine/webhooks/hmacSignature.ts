// webhook HMAC signing/verification — the shared helper both the
// OUTBOUND notification webhook channel and the INBOUND webhook receivers stand
// on (integration-provisioning.md).
//
// Outbound: we sign each webhook body with an HMAC-SHA256 under the target's
// signing secret and send the digest as `X-Tanren-Signature: sha256=<hex>` plus
// an `X-Tanren-Timestamp` header. The signature is computed over
// `<timestamp>.<body>` so the timestamp is BOUND into the digest — a replayed
// request with a stale timestamp re-derives a digest that no longer matches the
// (timestamp, body) the attacker can present, and a receiver can additionally
// reject a timestamp outside its freshness window.
//
// Inbound: a receiver re-derives the digest over the same canonical input and
// compares it to the presented signature with a CONSTANT-TIME compare so the
// digest is never leaked through a timing side-channel. A missing/malformed
// signature, an absent secret, or a mismatch all fail CLOSED (no unauthenticated
// intake).
//
// The secret VALUE never appears in a return value, a thrown message, or a log:
// only verdicts ({ ok } / a static reason string) and the public digest cross
// the boundary.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The signature scheme prefix carried on the wire (`sha256=<hex>`). */
const SHA256_PREFIX = "sha256=";

/** Outbound: the headers a signed webhook carries. */
export interface WebhookSignatureHeaders {
  /** `sha256=<hex>` HMAC over `<timestamp>.<body>`. */
  signature: string;
  /** The unix-seconds timestamp bound into the signature (replay guard). */
  timestamp: string;
}

/** A verification verdict the receiver maps to an HTTP response (proceed vs. 401). */
export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/** The canonical signing input binds the timestamp into the digest. */
function signingInput(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/**
 * Compute the HMAC-SHA256 signature for an outbound webhook body. Returns the
 * `sha256=<hex>` signature plus the timestamp it was bound to, ready to send as
 * `X-Tanren-Signature` / `X-Tanren-Timestamp` headers. `nowMs` is injectable so
 * tests pin the timestamp; production passes `Date.now()`.
 */
export function signWebhookBody(input: { body: string; secret: string; nowMs?: number }): WebhookSignatureHeaders {
  const timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const digest = createHmac("sha256", input.secret).update(signingInput(timestamp, input.body), "utf8").digest("hex");
  return { signature: `${SHA256_PREFIX}${digest}`, timestamp };
}

/**
 * Verify an inbound webhook signature (`sha256=<hex>`) over `<timestamp>.<body>`
 * under the shared secret, constant-time. An empty secret, a missing/malformed
 * signature header, or a digest mismatch fails closed. When `toleranceSeconds`
 * is provided the timestamp must also be within that window of `nowMs` (replay
 * guard); omit it to skip the freshness check.
 */
export function verifyWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): SignatureCheck {
  if (input.secret === "") return { ok: false, reason: "no webhook secret configured" };
  const header = input.signatureHeader ?? "";
  if (!header.startsWith(SHA256_PREFIX)) return { ok: false, reason: "missing or malformed signature header" };
  const timestamp = input.timestampHeader ?? "";
  if (timestamp === "" || !/^\d+$/u.test(timestamp)) return { ok: false, reason: "missing or malformed timestamp" };
  if (input.toleranceSeconds !== undefined) {
    const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > input.toleranceSeconds) {
      return { ok: false, reason: "timestamp outside tolerance" };
    }
  }
  const provided = header.slice(SHA256_PREFIX.length);
  const expected = createHmac("sha256", input.secret)
    .update(signingInput(timestamp, input.rawBody), "utf8")
    .digest("hex");
  return constantTimeEqualHex(provided, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Constant-time hex-string compare. Returns false (never throws) on a length
 * mismatch — `timingSafeEqual` requires equal-length buffers, so we guard first.
 * Shared by every webhook verifier (generic + the GitHub raw-body variant).
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
