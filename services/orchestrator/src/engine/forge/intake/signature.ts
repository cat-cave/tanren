// P1d autonomous intake — webhook signature verification (autonomy-engine.md
// §1d: "Webhook signature verification is mandatory — no unauthenticated
// intake.").
//
// Each provider signs its webhook body with a shared secret. We resolve the
// per-source secret from the SecretStore (the source's `config.webhookSecretRef`)
// and verify the provider's signature header over the RAW request body with a
// constant-time compare. A source with no configured secret CANNOT receive a
// webhook (the receiver rejects it) — there is no "unsigned is fine" path.

import { createHmac } from "node:crypto";
import { constantTimeEqualHex, type SignatureCheck } from "../../webhooks/hmacSignature.js";

export type { SignatureCheck };

/**
 * Verify a GitHub webhook signature (`X-Hub-Signature-256`: `sha256=<hex>`),
 * an HMAC-SHA256 of the RAW body under the source's shared secret. GitHub's
 * scheme signs the body only (no timestamp binding), so this stays distinct
 * from the generic Tanren scheme in `hmacSignature.ts`; both share the
 * constant-time hex compare so the digest is never leaked via timing. A
 * missing/malformed header or absent secret fails closed.
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
