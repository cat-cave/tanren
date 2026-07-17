import { createHash } from "node:crypto";

/**
 * JSON canonicalization used for policy identity. Object keys are ordered
 * lexicographically and arrays retain their semantic order. The compiler sorts
 * unordered rule collections before this function is called.
 */
export function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalPolicyValue(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalPolicyValue(record[key])]),
    );
  }
  return value;
}

export function canonicalPolicyBytes(value: unknown): Uint8Array {
  const canonical = JSON.stringify(canonicalPolicyValue(value));
  if (canonical === undefined) throw new Error("policy canonicalization produced no JSON value");
  return new TextEncoder().encode(canonical);
}

/** Stable content identity; this is always computed, never supplied by a caller. */
export function policyHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalPolicyBytes(value)).digest("hex")}`;
}
