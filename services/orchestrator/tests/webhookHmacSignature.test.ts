// P-INT-6 — the shared webhook HMAC sign/verify helper (constant-time,
// timestamp-bound). Both the outbound notification webhook channel and the
// inbound receivers stand on this surface.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { constantTimeEqualHex, signWebhookBody, verifyWebhookSignature } from "../src/engine/webhooks/hmacSignature.js";

const SECRET = "wh-signing-secret";
const BODY = JSON.stringify({ eventName: "run.failed", severity: "fail" });

describe("signWebhookBody", () => {
  it("produces an HMAC-SHA256 over <timestamp>.<body> that re-derives", () => {
    const nowMs = 1_700_000_000_000;
    const { signature, timestamp } = signWebhookBody({ body: BODY, secret: SECRET, nowMs });
    expect(timestamp).toBe(String(Math.floor(nowMs / 1000)));
    const expected = createHmac("sha256", SECRET).update(`${timestamp}.${BODY}`, "utf8").digest("hex");
    expect(signature).toBe(`sha256=${expected}`);
  });

  it("verifies a body signed with the secret (round-trip)", () => {
    const nowMs = 1_700_000_500_000;
    const { signature, timestamp } = signWebhookBody({ body: BODY, secret: SECRET, nowMs });
    const check = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: signature,
      timestampHeader: timestamp,
      secret: SECRET,
    });
    expect(check.ok).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  const signed = signWebhookBody({ body: BODY, secret: SECRET, nowMs: 1_700_000_000_000 });

  it("rejects a tampered body", () => {
    const check = verifyWebhookSignature({
      rawBody: `${BODY} tampered`,
      signatureHeader: signed.signature,
      timestampHeader: signed.timestamp,
      secret: SECRET,
    });
    expect(check).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a wrong secret", () => {
    const check = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: signed.signature,
      timestampHeader: signed.timestamp,
      secret: "other-secret",
    });
    expect(check.ok).toBe(false);
  });

  it("fails closed on an empty secret, missing header, and malformed header", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signed.signature,
        timestampHeader: signed.timestamp,
        secret: "",
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: undefined,
        timestampHeader: signed.timestamp,
        secret: SECRET,
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: "md5=abc",
        timestampHeader: signed.timestamp,
        secret: SECRET,
      }).ok,
    ).toBe(false);
  });

  it("rejects a missing/non-numeric timestamp", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signed.signature,
        timestampHeader: undefined,
        secret: SECRET,
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signed.signature,
        timestampHeader: "not-a-number",
        secret: SECRET,
      }).ok,
    ).toBe(false);
  });

  it("enforces a freshness window when toleranceSeconds is set (replay guard)", () => {
    const nowMs = 1_700_000_000_000;
    const fresh = signWebhookBody({ body: BODY, secret: SECRET, nowMs });
    // Same instant: accepted.
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: fresh.signature,
        timestampHeader: fresh.timestamp,
        secret: SECRET,
        toleranceSeconds: 300,
        nowMs,
      }).ok,
    ).toBe(true);
    // 10 minutes later, 5-minute window: rejected as a replay.
    const replay = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: fresh.signature,
      timestampHeader: fresh.timestamp,
      secret: SECRET,
      toleranceSeconds: 300,
      nowMs: nowMs + 600_000,
    });
    expect(replay).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });
});

describe("constantTimeEqualHex", () => {
  it("uses timingSafeEqual for equal-length hex and false for length mismatch", () => {
    const a = createHmac("sha256", SECRET).update("x").digest("hex");
    expect(constantTimeEqualHex(a, a)).toBe(true);
    expect(constantTimeEqualHex(a, a.slice(0, -2))).toBe(false);
    expect(constantTimeEqualHex("", "")).toBe(false);
  });
});
