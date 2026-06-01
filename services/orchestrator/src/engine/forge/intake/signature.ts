// P1d autonomous intake — webhook signature verification (autonomy-engine.md
// §1d: "Webhook signature verification is mandatory — no unauthenticated
// intake.").
//
// Each provider signs its webhook body with a shared secret. We resolve the
// per-source secret from the SecretStore (the source's `config.webhookSecretRef`)
// and verify the provider's signature header over the RAW request body with a
// constant-time compare. A source with no configured secret CANNOT receive a
// webhook (the receiver rejects it) — there is no "unsigned is fine" path.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verdicts the receiver maps to HTTP responses (401 vs. proceed). */
export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify a GitHub webhook signature (`X-Hub-Signature-256`: `sha256=<hex>`),
 * an HMAC-SHA256 of the raw body under the source's shared secret. Constant-time
 * to avoid leaking the digest via timing. A missing/malformed header or secret
 * fails closed.
 */
export function verifyGithubSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string;
}): SignatureCheck {
  if (input.secret === "") return { ok: false, reason: "no webhook secret configured for source" };
  const header = input.signatureHeader ?? "";
  if (!header.startsWith("sha256=")) return { ok: false, reason: "missing or malformed signature header" };
  const provided = header.slice("sha256=".length);
  const expected = createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex");
  return constantTimeEqualHex(provided, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Constant-time hex-string compare. Returns false (never throws) on a length
 * mismatch — `timingSafeEqual` requires equal-length buffers, so we guard first.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
