// Shared config-revision CAS vocabulary for projects + organizations.
// Application-owned BIGINT generation only — never PostgreSQL xmin.
// Closed range matches the DB CHECK on both tables (mode: "number" kit-safe).

import { z } from "zod";

/** Inclusive floor — revision starts at 1; zero/negative are invalid tokens. */
export const CONFIG_REVISION_MIN = 1;
/**
 * Inclusive ceiling — `Number.MAX_SAFE_INTEGER`. Physical column remains BIGINT;
 * CHECK + every wire/parser boundary refuse values outside this closed range so
 * ORM `mode: "number"` cannot silently lose precision.
 */
export const CONFIG_REVISION_MAX = Number.MAX_SAFE_INTEGER;
export const CONFIG_REVISION_MAX_TEXT = String(CONFIG_REVISION_MAX);

const CANONICAL_DECIMAL = /^[1-9]\d*$/u;
const MIN_BI = BigInt(CONFIG_REVISION_MIN);
const MAX_BI = BigInt(CONFIG_REVISION_MAX);

/** True only for a canonical decimal token strictly inside the closed range. */
export function isCanonicalConfigRevisionToken(value: string): boolean {
  if (!CANONICAL_DECIMAL.test(value)) return false;
  // Digit-length short-circuit: MAX is 16 digits; longer is always out of range.
  if (value.length > CONFIG_REVISION_MAX_TEXT.length) return false;
  try {
    const n = BigInt(value);
    return n >= MIN_BI && n <= MAX_BI;
  } catch {
    return false;
  }
}

/** Decimal string of the row's config_revision (stable external CAS token). */
export const ConfigRevisionSchema = z.string().refine(isCanonicalConfigRevisionToken, {
  message: `config_revision must be a canonical decimal integer in [${CONFIG_REVISION_MIN}, ${CONFIG_REVISION_MAX}]`,
});
export type ConfigRevision = z.infer<typeof ConfigRevisionSchema>;

export interface ConfigSnapshot {
  config: unknown;
  revision: ConfigRevision;
}

export type ConfigCasOutcome =
  | { status: "ok"; config: unknown; revision: ConfigRevision }
  | { status: "conflict"; current: ConfigSnapshot }
  | { status: "not_found" };

/**
 * Parse a Postgres bigint / text / number revision into the canonical decimal
 * string. Rejects zero, negative, leading-zero, signed, fractional, exponential,
 * whitespace, overflow, NaN, Infinity, and unsafe JS numbers. Bigint inputs are
 * range-checked. Never returns a raw JS bigint (JSON-safe decimal text only).
 */
export function revisionText(value: unknown): ConfigRevision {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < CONFIG_REVISION_MIN || value > CONFIG_REVISION_MAX) {
      throw new Error(`invalid config_revision token: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (!isCanonicalConfigRevisionToken(value)) {
      throw new Error(`invalid config_revision token: ${value}`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    if (value < MIN_BI || value > MAX_BI) {
      throw new Error(`invalid config_revision token: ${value.toString()}`);
    }
    return value.toString();
  }
  throw new Error(`invalid config_revision token: ${String(value)}`);
}

/**
 * Fail-closed when a revision-predicated CAS UPDATE returns zero rows but the
 * re-read still shows the expected revision with a config that is distinct from
 * the proposed next blob. That combination is not reachable under the sole CAS
 * SQL (`config_revision` match + `config IS DISTINCT FROM`); surface it loudly.
 */
export function configCasImpossibleMiss(kind: "project" | "organization", id: string, expectedRevision: string): never {
  throw new Error(
    `config CAS fail-closed: ${kind}=${id} expectedRevision=${expectedRevision} still current but UPDATE missed with distinct config`,
  );
}
