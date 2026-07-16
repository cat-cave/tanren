// gv-3 — sole authority for the LAND/proof POLICY identity and the fail-closed
// blank-hash guards. The schema literal `projectConfig.version === 1` is NOT a
// policy identity; the empty `gateConfigHash: ""` is NOT a sound land binding.
//
// Policy identity is a deterministic sha256 over the governance-sensitive slice
// of ProjectConfigV1. Gate identity reuses `hashGateConfig` (the batch proof-reuse
// path's sole algorithm) so land and batch never diverge on the same CiConfig.

import { createHash } from "node:crypto";
import type { ProjectConfigV1 } from "../config/projectConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { resolveCiConfig, type CiConfigV1 } from "../ci/index.js";
import { hashGateConfig } from "../dag/integrationProofKey.js";

/** Separator that never appears in a hashed token (same doctrine as hashGateConfig). */
const HASH_SEP = "\u0000";

/** The one accepted wire/storage form for policy and gate content identities. */
const CONTENT_IDENTITY_PATTERN = /^[0-9a-f]{64}$/u;

/** True only for a canonical lowercase sha256 content identity. */
export function isCanonicalContentIdentity(value: string): boolean {
  return CONTENT_IDENTITY_PATTERN.test(value);
}

/**
 * Require the canonical identity form at a persistence boundary. This is shared by
 * every integration-node writer so no caller can reintroduce an empty/schema-era
 * identity through an optional/defaulted field.
 */
export function requireCanonicalContentIdentity(value: string, field: string): string {
  if (!isCanonicalContentIdentity(value)) {
    throw new Error(`${field} must be a canonical lowercase 64-hex content identity`);
  }
  return value;
}

/**
 * Governance-sensitive fields folded into the policy identity. Order is fixed for
 * the hash transcript; field names are part of the transcript so a future addition
 * cannot silently collide with a prior value encoding.
 */
export const POLICY_IDENTITY_FIELDS = [
  "auditPosture",
  "reviewPolicy",
  "governancePosture",
  "mergeIntegration",
  "speculationThreshold",
  "speculativeIntegrationDepth",
  "maxBatchSize",
  "insightThresholds",
  "convergencePolicy",
  "governanceTanrenLogins",
  "governancePlatformLogins",
  "budget",
] as const;

export type PolicyIdentityField = (typeof POLICY_IDENTITY_FIELDS)[number];

/** Stable non-empty hex digest of the governance-sensitive project policy. PURE. */
export function hashProjectPolicy(config: ProjectConfigV1): string {
  const h = createHash("sha256");
  h.update("projectPolicy.v1");
  h.update(HASH_SEP);
  for (const field of POLICY_IDENTITY_FIELDS) {
    h.update(field);
    h.update(HASH_SEP);
    h.update(encodePolicyField(field, config));
    h.update(HASH_SEP);
  }
  return h.digest("hex");
}

/**
 * Resolve the land/proof policy identity from raw project config jsonb.
 * Throws on unparseable config (fail-closed — never invent a default identity).
 */
export function resolveProjectPolicyIdentity(projectConfigRaw: unknown): {
  policyHash: string;
  fields: readonly PolicyIdentityField[];
} {
  const config = migrateProjectConfig(projectConfigRaw);
  return { policyHash: hashProjectPolicy(config), fields: POLICY_IDENTITY_FIELDS };
}

/** Hash a resolved CiConfigV1 — the sole gate-config algorithm (re-export surface). */
export function resolveGateConfigHash(config: CiConfigV1): string {
  return hashGateConfig(config);
}

/**
 * Parse YAML text (or the documented default when absent) into a gate-config hash.
 * Invalid YAML/schema throws — callers map that to fail-closed land denial.
 */
export function resolveGateConfigHashFromYaml(yamlText?: string): string {
  return hashGateConfig(resolveCiConfig(yamlText));
}

/**
 * Fail-closed land validation. Blank identities retain their specific diagnosis;
 * every other non-canonical form (schema literal, whitespace-padded, wrong length,
 * or uppercase) receives an invalid-content-identity diagnosis.
 */
export function landIdentityValidationReason(input: {
  gateConfigHash: string;
  policyVersion: string;
}):
  | "blank_gate_config_hash"
  | "invalid_gate_config_hash"
  | "blank_policy_version"
  | "invalid_policy_version"
  | undefined {
  if (input.gateConfigHash.trim() === "") return "blank_gate_config_hash";
  if (!isCanonicalContentIdentity(input.gateConfigHash)) return "invalid_gate_config_hash";
  if (input.policyVersion.trim() === "") return "blank_policy_version";
  if (!isCanonicalContentIdentity(input.policyVersion)) return "invalid_policy_version";
  return undefined;
}

function encodePolicyField(field: PolicyIdentityField, config: ProjectConfigV1): string {
  switch (field) {
    case "auditPosture":
      return stableJson({
        blockReviewAt: config.auditPosture.blockReviewAt,
        p2p3Handling: config.auditPosture.p2p3Handling,
        autonomousRemediation: config.auditPosture.autonomousRemediation,
      });
    case "reviewPolicy":
      return config.reviewPolicy;
    case "governancePosture":
      return config.governancePosture;
    case "mergeIntegration":
      return config.mergeIntegration;
    case "speculationThreshold":
      return config.speculationThreshold;
    case "speculativeIntegrationDepth":
      return String(config.speculativeIntegrationDepth);
    case "maxBatchSize":
      return String(config.maxBatchSize);
    case "insightThresholds":
      return stableJson(config.insightThresholds);
    case "convergencePolicy":
      return stableJson(config.convergencePolicy);
    case "governanceTanrenLogins":
      return stableJson([...(config.governanceTanrenLogins ?? [])].sort());
    case "governancePlatformLogins":
      return stableJson([...(config.governancePlatformLogins ?? [])].sort());
    case "budget": {
      const budget = config.budget;
      if (budget === undefined) return "absent";
      return stableJson({
        ceilingUsd: budget.ceilingUsd ?? null,
        period: budget.period ?? null,
      });
    }
    default: {
      throw new Error(`unknown policy identity field: ${String(field satisfies never)}`);
    }
  }
}

/** Deterministic JSON with sorted object keys (order-independent). */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}
