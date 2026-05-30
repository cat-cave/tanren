import { createHash } from "node:crypto";

const hexSha256Pattern = /^[a-f0-9]{64}$/u;
const colonHexSha256Pattern = /^([a-f0-9]{2}:){31}[a-f0-9]{2}$/u;

export function sshSha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
}

export function normalizeHostKeyFingerprint(fingerprint: string): string | undefined {
  const trimmed = fingerprint.trim();
  const lower = trimmed.toLowerCase();

  if (hexSha256Pattern.test(lower)) {
    return lower;
  }
  if (colonHexSha256Pattern.test(lower)) {
    return lower.replaceAll(":", "");
  }
  if (trimmed.startsWith("SHA256:")) {
    const encoded = trimmed.slice("SHA256:".length);
    try {
      const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
      const decoded = Buffer.from(padded, "base64");
      return decoded.length === 32 ? decoded.toString("hex") : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function hostKeyFingerprintMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeHostKeyFingerprint(actual);
  const normalizedExpected = normalizeHostKeyFingerprint(expected);
  return normalizedActual !== undefined && normalizedActual === normalizedExpected;
}
