// ds-0 — DesignContractV2: the executable-design-system INTENT contract.
//
// V2 is the durable design-intent layer of the design-system engine (mission
// design bucket §1). It migrates LOSSLESSLY from the persisted `DesignContractV1`
// (designContract.ts) — every V1 field is preserved verbatim — and ADDS the
// intent the executable pipeline (ds-1..8) needs but V1 could not carry:
//
//   · `desiredSurfaces`     — the product SURFACES the design must cover (a
//                             dashboard, an onboarding flow, a game HUD), each
//                             bound to the personas/behaviors it serves. Intent,
//                             never generated source.
//   · `targetProfiles`      — the desired framework/target CAPABILITIES the
//                             design projects onto (web-react, bevy, swiftui …).
//                             An unknown-but-valid capability is an F2D gap (ds-3),
//                             never "closest available".
//   · `accessibilityPosture`— the a11y bar the A4 gate (ds-4) judges against.
//   · `exportRequirements`  — the export projections the release must emit (ds-5).
//   · `acceptanceIntent`    — the design north-star the oracle (ds-4) verifies.
//
// It STILL never embeds generated source (tokens/components/assets live on the
// immutable `DesignSystemReleaseV1` + `FrameworkDesignArtifactV1`, not here).
//
// NO SILENT DEFAULTS. Like V1 + the template manifest, a malformed contract
// ALWAYS throws a typed `DesignContractV2CorruptError` (never degrades to a
// default): a half-described contract is a LOUD failure, not a quiet stub.
//
// This module is the CONTRACT + PARSER + lossless migrator only. Persistence is
// the `DesignSystemReleaseStore` seam (designSystemStore.ts); injection into the
// writer is ds-2; verification is the ds-4 oracle. Those are the clean seams this
// foundation leaves.

import { createHash } from "node:crypto";
import { z } from "zod";
import { DesignDimension, normalizeDesignContract } from "../designContract.js";
import type { DesignContractV1 } from "../designContract.js";

export const DESIGN_CONTRACT_V2_VERSION = 2 as const;

// ---- Desired surface -------------------------------------------------------

// One product SURFACE the design is responsible for. Domain-general: a SaaS app
// declares `dashboard`/`settings`; a game declares `hud`/`inventory`; a novel
// `cover`/`chapter`. `key` is a stable opaque slug; `intent` says what good looks
// like on the surface; the persona/behavior refs bind it to the entity graph.
export const DesignDesiredSurface = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    intent: z.string().min(1).max(2000),
    personaRefs: z.array(z.string().min(1)).default([]),
    behaviorRefs: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type DesignDesiredSurface = z.infer<typeof DesignDesiredSurface>;

// ---- Target profile (desired capability) -----------------------------------

// A desired framework/target the design projects onto. `target` is the adapter
// key (open-string, exactly like template selection — an unknown valid target is
// an F2D gap, not "unsupported"); `capabilities` are the specific capabilities
// the design requires of it. Tanren NEVER branches on these labels.
export const DesignTargetProfileIntent = z
  .object({
    target: z.string().min(1).max(120),
    capabilities: z.array(z.string().min(1).max(120)).default([]),
    required: z.boolean().default(true),
  })
  .strict();
export type DesignTargetProfileIntent = z.infer<typeof DesignTargetProfileIntent>;

// ---- Accessibility posture -------------------------------------------------

export const DesignAccessibilityPosture = z
  .object({
    // The a11y standard the design targets (free string — "wcag-2.2-aa",
    // "apple-hig", "none"). Descriptive; the ds-4 oracle reads it, Tanren does
    // not branch on it.
    standard: z.string().min(1).max(120).default("none"),
    notes: z.string().max(2000).default(""),
  })
  .strict();
export type DesignAccessibilityPosture = z.infer<typeof DesignAccessibilityPosture>;

// ---- Contract --------------------------------------------------------------

export const DesignContractV2 = z
  .object({
    version: z.literal(DESIGN_CONTRACT_V2_VERSION),
    domain: z.string().min(1).max(120),
    // --- V1 core (preserved verbatim across the migration) ---
    identity: z.string().min(1).max(400),
    intent: z.string().min(1).max(4000),
    principles: z.array(z.string().min(1).max(400)).default([]),
    constraints: z.array(z.string().min(1).max(400)).default([]),
    personaRefs: z.array(z.string().min(1)).default([]),
    behaviorRefs: z.array(z.string().min(1)).default([]),
    dimensions: z.array(DesignDimension).default([]),
    // --- V2 additions (all optional-with-empty-default so the migration from a
    // minimal V1 is total; each is intent, never generated source) ---
    desiredSurfaces: z.array(DesignDesiredSurface).default([]),
    targetProfiles: z.array(DesignTargetProfileIntent).default([]),
    accessibilityPosture: DesignAccessibilityPosture.default({ standard: "none", notes: "" }),
    exportRequirements: z.array(z.string().min(1).max(120)).default([]),
    acceptanceIntent: z.string().max(4000).default(""),
  })
  .strict();
export type DesignContractV2 = z.infer<typeof DesignContractV2>;

/** Thrown when a blob does not parse as a valid `DesignContractV2`. Fail-closed. */
export class DesignContractV2CorruptError extends Error {
  constructor(
    readonly issues: string,
    options?: { cause?: unknown },
  ) {
    super(`design contract v2 is corrupt: ${issues}`, options);
    this.name = "DesignContractV2CorruptError";
  }
}

/**
 * Parse an UNKNOWN blob (e.g. persisted jsonb) into a `DesignContractV2`, throwing
 * a typed `DesignContractV2CorruptError` on any malformed shape (no silent
 * degrade), exactly like the V1 + template-manifest parsers.
 */
export function parseDesignContractV2(value: unknown): DesignContractV2 {
  const result = DesignContractV2.safeParse(value);
  if (!result.success) {
    throw new DesignContractV2CorruptError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
      { cause: result.error },
    );
  }
  return normalizeDesignContractV2(result.data);
}

/** Deep-clone a parsed contract into its canonical field order (round-trip identity). */
export function normalizeDesignContractV2(parsed: DesignContractV2): DesignContractV2 {
  return {
    version: DESIGN_CONTRACT_V2_VERSION,
    domain: parsed.domain,
    identity: parsed.identity,
    intent: parsed.intent,
    principles: [...parsed.principles],
    constraints: [...parsed.constraints],
    personaRefs: [...parsed.personaRefs],
    behaviorRefs: [...parsed.behaviorRefs],
    dimensions: parsed.dimensions.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      intent: dimension.intent,
      guidance: dimension.guidance,
      personaRefs: [...dimension.personaRefs],
    })),
    desiredSurfaces: parsed.desiredSurfaces.map((surface) => ({
      key: surface.key,
      label: surface.label,
      intent: surface.intent,
      personaRefs: [...surface.personaRefs],
      behaviorRefs: [...surface.behaviorRefs],
    })),
    targetProfiles: parsed.targetProfiles.map((profile) => ({
      target: profile.target,
      capabilities: [...profile.capabilities],
      required: profile.required,
    })),
    accessibilityPosture: {
      standard: parsed.accessibilityPosture.standard,
      notes: parsed.accessibilityPosture.notes,
    },
    exportRequirements: [...parsed.exportRequirements],
    acceptanceIntent: parsed.acceptanceIntent,
  };
}

/**
 * Migrate a persisted `DesignContractV1` LOSSLESSLY to V2. Every V1 field is
 * preserved; the V2-only fields default to their empty-but-valid state. Accepts
 * either a typed V1 or an unknown blob (re-parsed through V1 first, so a
 * malformed V1 throws its own V1 error before reaching here).
 */
export function migrateDesignContractV1ToV2(value: DesignContractV1 | unknown): DesignContractV2 {
  const v1 = normalizeDesignContract(value);
  return normalizeDesignContractV2({
    version: DESIGN_CONTRACT_V2_VERSION,
    domain: v1.domain,
    identity: v1.identity,
    intent: v1.intent,
    principles: v1.principles,
    constraints: v1.constraints,
    personaRefs: v1.personaRefs,
    behaviorRefs: v1.behaviorRefs,
    dimensions: v1.dimensions,
    desiredSurfaces: [],
    targetProfiles: [],
    accessibilityPosture: { standard: "none", notes: "" },
    exportRequirements: [],
    acceptanceIntent: "",
  });
}

/** Canonical schema-normalized JSON for receipts, digests, and persistence. */
export function canonicalDesignContractV2Json(value: unknown): string {
  return JSON.stringify(parseDesignContractV2(value));
}

/** Content-address a contract: the `contract_digest` proof anchor persisted on a release. */
export function designContractV2Digest(value: unknown): string {
  const body = JSON.stringify(["tanren.design-contract.v2", parseDesignContractV2(value)]);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

/** Serialize a contract to a plain jsonb object (round-trip is identity by construction). */
export function designContractV2ToJson(contract: DesignContractV2): Record<string, unknown> {
  return normalizeDesignContractV2(contract) as Record<string, unknown>;
}
