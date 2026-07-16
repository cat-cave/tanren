// Shared config-revision CAS vocabulary for projects + organizations.
// Application-owned BIGINT generation only — never PostgreSQL xmin.

import { z } from "zod";

/** Decimal string of the row's config_revision (stable external CAS token). */
export const ConfigRevisionSchema = z.string().regex(/^[1-9]\d*$/u);
export type ConfigRevision = z.infer<typeof ConfigRevisionSchema>;

export interface ConfigSnapshot {
  config: unknown;
  revision: ConfigRevision;
}

export type ConfigCasOutcome =
  | { status: "ok"; config: unknown; revision: ConfigRevision }
  | { status: "conflict"; current: ConfigSnapshot }
  | { status: "not_found" };

/** Parse a Postgres bigint / text revision into the canonical decimal string. */
export function revisionText(value: unknown): ConfigRevision {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    return value;
  }
  if (typeof value === "bigint" && value >= 1n) {
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
