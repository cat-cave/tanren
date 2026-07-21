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
import { DesignAccessibilityPosture, DesignDimension, normalizeDesignContract } from "../designContract.js";

// Re-exported so the ds-4 render seam (renderVerdictOracle / composeDesignRenderVerification /
// designSystemRenderVerification) reaches the posture type through the V2 module it already
// imports — the schema itself is now DEFINED on V1 (designContract.ts) so a persisted V1 blob
// CARRIES the real posture across the round-trip (never re-defaulted at migration time).
export { DesignAccessibilityPosture } from "../designContract.js";

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

// ---- Visual verification knob (ds-4 Slice B) -------------------------------

// The opt-in knob that turns on the PIXEL (browser screenshot + visual-diff) render
// verification alongside the always-on browser-free a11y path. DEFAULT OFF: the pixel
// path needs container infra (podman + the render-worker image) that is not in every
// env, so an un-opted project runs the a11y-only path exactly as before (no podman
// invocation). When ON, the pixel scenarios feed the SAME fail-closed design_render
// gate; `imageDiffThreshold` is the max per-pixel diff ratio a render may drift before
// it is a `failed_visual` (0 = strictest; a small default tolerates sub-pixel noise).
export const DesignVisualVerification = z
  .object({
    enabled: z.boolean().default(false),
    imageDiffThreshold: z.number().min(0).max(1).default(0.01),
  })
  .strict();
export type DesignVisualVerification = z.infer<typeof DesignVisualVerification>;

const DEFAULT_VISUAL_VERIFICATION: DesignVisualVerification = { enabled: false, imageDiffThreshold: 0.01 };

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
    // ds-4 Slice B: the opt-in pixel visual-verification knob (default off).
    visualVerification: DesignVisualVerification.default(DEFAULT_VISUAL_VERIFICATION),
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
    visualVerification: {
      enabled: parsed.visualVerification.enabled,
      imageDiffThreshold: parsed.visualVerification.imageDiffThreshold,
    },
  };
}

/**
 * Migrate a persisted design contract to V2. FORWARD-COMPATIBLE: accepts BOTH
 * a V1 strict blob (every V1 field preserved; V2-only fields default to empty)
 * AND a full-V2 capture blob (the future persistence shape a design agent emits
 * once it authors `desiredSurfaces` / `targetProfiles` / `accessibilityPosture`
 * natively). A V2 input passes through unchanged; a V1 input is migrated
 * losslessly. A malformed shape throws its own typed error before reaching the
 * V2 builder — fail-closed.
 */
export function migrateDesignContractV1ToV2(value: unknown): DesignContractV2 {
  // Try V2 strict first — a full-V2 capture persists V2 natively (forward-compat).
  // V2 strict REQUIRES `version: 2`; a V1 (version: 1) fails this branch.
  const v2Result = DesignContractV2.safeParse(value);
  if (v2Result.success) return normalizeDesignContractV2(v2Result.data);
  // V1 strict parse + lossless migration. A malformed V1 throws its own V1 error.
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
    // Carry the REAL posture the design agent captured (persisted on V1). A V1 that
    // declared no a11y bar carries an honest `none` (advisory) — this is NOT a
    // hardcoded migration default; the value round-trips from `design_contracts`.
    accessibilityPosture: v1.accessibilityPosture,
    exportRequirements: [],
    acceptanceIntent: "",
    // A migrated V1 never carried a visual-verification knob → default OFF (honest:
    // opt-in, never silently enabled by migration).
    visualVerification: DEFAULT_VISUAL_VERIFICATION,
  });
}

// The default web target profile the ds-2 `WebDesignTargetAdapter` composes against
// (the sole registered adapter). `required: true` — a real run needs the web system.
// This is contract intent for a V1 migration, not an adapter-default fallback at
// conformance time. It gives the default required target a non-vacuous set that
// a receipt must check exactly; an explicitly authored V2 profile is preserved.
const WEB_TARGET_PROFILE: DesignTargetProfileIntent = {
  target: "web-react",
  capabilities: ["css-variables", "tailwind", "shadcn", "radix", "catalog", "storybook", "exports", "dtcg"],
  required: true,
};

/**
 * Derive the `desiredSurfaces` a project's design must cover FROM the contract's own
 * authored content — the design-agent-chosen `dimensions` (each a real, persisted,
 * domain-derived design facet). This is the honest root that makes F2D meaningful:
 * `migrateDesignContractV1ToV2` is deliberately LOSSLESS (it cannot invent surfaces),
 * so this SEPARATE derivation is the explicit, opt-in projection the composer applies
 * when it needs the composition-need surfaces. Each dimension a project declares
 * becomes one desired surface (the patterns-and-templates the design system must carry
 * for that facet), carrying the facet's persona scope (its own `personaRefs`, else the
 * contract's whole persona set) and the contract's behavior obligation. A contract with
 * NO dimensions yields NO surfaces (a real empty state) — never a fabricated stub.
 */
export function deriveDesiredSurfaces(contract: DesignContractV2): DesignDesiredSurface[] {
  const seen = new Set<string>();
  const surfaces: DesignDesiredSurface[] = [];
  for (const dimension of contract.dimensions) {
    if (seen.has(dimension.key)) continue;
    seen.add(dimension.key);
    surfaces.push({
      key: dimension.key,
      label: dimension.label,
      intent: dimension.intent,
      personaRefs: dimension.personaRefs.length > 0 ? [...dimension.personaRefs] : [...contract.personaRefs],
      behaviorRefs: [...contract.behaviorRefs],
    });
  }
  return surfaces;
}

/**
 * Compose the executable V2 the design-system PRODUCER reads: the lossless migration
 * PLUS the derived `desiredSurfaces` (from the authored dimensions) and — when the
 * contract declares none — the default `web-react` target profile. This is the
 * contract the composer feeds `requiredDesignFragmentsFromSurfaces` → F2D, so a real
 * run's contract carries the surfaces the product needs rather than an empty stub. An
 * explicitly-authored surface/profile set (a future full-V2 persistence) is preserved.
 */
export function withDerivedDesiredSurfaces(contract: DesignContractV2): DesignContractV2 {
  const desiredSurfaces =
    contract.desiredSurfaces.length > 0 ? contract.desiredSurfaces : deriveDesiredSurfaces(contract);
  const targetProfiles = contract.targetProfiles.length > 0 ? contract.targetProfiles : [WEB_TARGET_PROFILE];
  return normalizeDesignContractV2({ ...contract, desiredSurfaces, targetProfiles });
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
