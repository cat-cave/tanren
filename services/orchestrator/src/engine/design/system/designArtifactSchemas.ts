// ds-0 — the executable-design-system ARTIFACT schemas (foundation contracts).
//
// The typed shapes ds-1..8 build their bodies against, mapping onto the
// `design_systems` / `design_system_releases` / `design_artifacts` /
// `design_artifact_files` backbone (schemaDesignSystems.ts). Three deliberately
// separate layers (design bucket §1):
//
//   · `DesignSystemReleaseV1`         — the immutable, versioned RELEASE record
//                                       (intent digest + manifest schema + the
//                                       canonical artifact it resolves to).
//   · `FrameworkDesignArtifactManifestV1` — the content-addressed ARTIFACT
//                                       manifest: real files, fragment lineage,
//                                       exports, and validation proof digests for
//                                       one target profile.
//   · `DesignFragmentSpecV1`          — the fragment CONTRACT the F2D selector
//                                       (ds-3) plans + authors against. This is
//                                       the SPEC shape, not the fragment table.
//
// FOUNDATION ONLY: these are the typed schemas + parsers. The composers, the
// DesignVfs, the CAS artifact store, the F2D authoring DAG, and the A4 render
// harness that PRODUCE these artifacts are ds-1..4 and are deliberately not built
// here. A malformed blob throws a typed `DesignArtifactSchemaError` — fail-closed.

import { z } from "zod";

export const DESIGN_MANIFEST_SCHEMA_VERSION = 1 as const;

/** Canonical media type for a framework design artifact bundle manifest. */
export const DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE = "application/vnd.tanren.design-artifact.v1+json" as const;

/** The immutable release states (mirrors the design_system_releases CHECK). */
export const DesignReleaseState = z.enum(["draft", "validated", "published", "deprecated", "quarantined"]);
export type DesignReleaseState = z.infer<typeof DesignReleaseState>;

/**
 * The ordered fragment PHASES of the design compiler (design bucket §1). Every
 * design composition begins with an immutable `base/plain` fragment; curation
 * composes polished overlays without destroying the plain state. The compiler
 * (ds-1) walks these phases; ds-0 freezes the vocabulary + order so downstream
 * selection/dependency logic keys off a single source of truth.
 */
export const DESIGN_FRAGMENT_PHASES = [
  "base",
  "primitive-tokens",
  "semantic-tokens",
  "component-tokens",
  "theme-modes",
  "typography-icons-assets",
  "component-primitives",
  "components",
  "patterns-and-templates",
  "motion-and-interaction",
  "platform-binding",
  "catalog-and-scenarios",
  "exporters",
  "postprocessors",
] as const;
export type DesignFragmentPhase = (typeof DESIGN_FRAGMENT_PHASES)[number];
export const DesignFragmentPhase = z.enum(DESIGN_FRAGMENT_PHASES);

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u, "expected a sha256:<64-hex> content digest");
const Id = z.string().min(1).max(256);
const ByteSize = z.number().int().min(0);

/** Thrown when a blob does not parse as a valid design artifact/release/fragment shape. */
export class DesignArtifactSchemaError extends Error {
  constructor(
    readonly entity: string,
    readonly issues: string,
    options?: { cause?: unknown },
  ) {
    super(`design ${entity} schema is invalid: ${issues}`, options);
    this.name = "DesignArtifactSchemaError";
  }
}

function parseOrThrow<T>(entity: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DesignArtifactSchemaError(
      entity,
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
      { cause: result.error },
    );
  }
  return result.data;
}

// ---- DesignArtifactFileV1 --------------------------------------------------

export const DesignArtifactFileKind = z.enum([
  "manifest",
  "tokens",
  "resolver",
  "component-source",
  "component-contract",
  "asset",
  "catalog",
  "fixture",
  "export",
  "sbom",
  "provenance",
  "other",
]);
export type DesignArtifactFileKind = z.infer<typeof DesignArtifactFileKind>;

export const DesignArtifactFileV1 = z
  .object({
    // A normalized, forward-slash relative path. No traversal / absolute / empty
    // segment — validated structurally so a hostile manifest can never escape the
    // artifact root (the offline validator enforces this deeply).
    path: z.string().min(1).max(1024),
    kind: DesignArtifactFileKind,
    mediaType: z.string().min(1).max(256),
    digest: Sha256Digest,
    byteSize: ByteSize,
    executable: z.boolean().default(false),
  })
  .strict();
export type DesignArtifactFileV1 = z.infer<typeof DesignArtifactFileV1>;

// ---- FrameworkDesignArtifactManifestV1 -------------------------------------

/**
 * The design-artifact validation proof digests (design bucket §1 "the real
 * artifact"). Each is a content address into the proof substrate; absent until
 * the corresponding ds-4 proof runs, so every field is optional at foundation.
 */
export const DesignArtifactProofDigests = z
  .object({
    build: Sha256Digest.optional(),
    token: Sha256Digest.optional(),
    accessibility: Sha256Digest.optional(),
    interaction: Sha256Digest.optional(),
    render: Sha256Digest.optional(),
    oracle: Sha256Digest.optional(),
  })
  .strict();
export type DesignArtifactProofDigests = z.infer<typeof DesignArtifactProofDigests>;

export const FrameworkDesignArtifactManifestV1 = z
  .object({
    manifestVersion: z.literal(DESIGN_MANIFEST_SCHEMA_VERSION),
    artifactId: Id,
    releaseId: Id,
    // The target profile key this artifact projects onto (web-react, bevy …).
    target: z.string().min(1).max(120),
    contractDigest: Sha256Digest,
    // Plain-base + polished release digests (the machine-readable plain→polished
    // provenance the compiler preserves).
    plainReleaseDigest: Sha256Digest,
    polishedReleaseDigest: Sha256Digest,
    files: z.array(DesignArtifactFileV1).max(100_000),
    // Fragment lineage: the ordered fragment release ids composed into this artifact.
    fragmentLineage: z.array(Id).max(4096).default([]),
    // Export projection ids emitted from this release.
    exports: z.array(z.string().min(1).max(120)).max(256).default([]),
    proofDigests: DesignArtifactProofDigests.default({}),
  })
  .strict();
export type FrameworkDesignArtifactManifestV1 = z.infer<typeof FrameworkDesignArtifactManifestV1>;

export function parseDesignArtifactManifest(value: unknown): FrameworkDesignArtifactManifestV1 {
  return parseOrThrow("artifact-manifest", FrameworkDesignArtifactManifestV1, value);
}

// ---- DesignSystemReleaseV1 -------------------------------------------------

export const DesignSystemReleaseV1 = z
  .object({
    releaseId: Id,
    designSystemId: Id,
    version: z.number().int().min(1),
    parentReleaseId: Id.nullable().default(null),
    state: DesignReleaseState,
    contractId: Id,
    contractVersion: z.number().int().min(1),
    contractDigest: Sha256Digest,
    manifestSchemaVersion: z.number().int().min(1),
    canonicalArtifactId: Id.nullable().default(null),
    // Free-form compatibility summary (target/capability → status); the ds-2/ds-7
    // adapters populate it. Foundation keeps it an open record.
    compatibilitySummary: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((release, ctx) => {
    // Published/deprecated releases MUST resolve to a canonical artifact (mirrors
    // the design_system_releases_published_check DB invariant — fail-closed at
    // both the schema and the storage layer).
    if ((release.state === "published" || release.state === "deprecated") && release.canonicalArtifactId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalArtifactId"],
        message: `a ${release.state} release must carry a canonical artifact id`,
      });
    }
  });
export type DesignSystemReleaseV1 = z.infer<typeof DesignSystemReleaseV1>;

export function parseDesignSystemRelease(value: unknown): DesignSystemReleaseV1 {
  return parseOrThrow("system-release", DesignSystemReleaseV1, value);
}

// ---- DesignFragmentSpecV1 --------------------------------------------------

/**
 * The fragment CONTRACT the F2D selector (ds-3) plans + authors against. Mirrors
 * the template fragment doctrine: open-string kind (an unknown capability is an
 * F2D gap, not "closest available"), typed phase, explicit requires/provides/
 * dependsOn/conflicts/replaces, and a required conformance suite. This is the
 * SPEC shape only — the apply plan over the DesignVfs, the source outputs, and
 * the authoring DAG are ds-1/ds-3.
 */
export const DesignFragmentSpecV1 = z
  .object({
    // Open-string capability key ("base/plain", "bevy.tactical-hud"). Selection is
    // open-world — a missing key spawns F2D (ds-3), never a silent substitution.
    kind: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    phase: DesignFragmentPhase,
    version: z.string().min(1).max(128),
    digest: Sha256Digest.nullable().default(null),
    // Target/capability compatibility predicates this fragment applies under.
    targetCapabilities: z.array(z.string().min(1).max(120)).max(256).default([]),
    requires: z.array(z.string().min(1).max(200)).max(256).default([]),
    provides: z.array(z.string().min(1).max(200)).max(256).default([]),
    dependsOn: z.array(z.string().min(1).max(200)).max(256).default([]),
    conflicts: z.array(z.string().min(1).max(200)).max(256).default([]),
    replaces: z.array(z.string().min(1).max(200)).max(256).default([]),
    personaRefs: z.array(Id).max(1024).default([]),
    behaviorRefs: z.array(Id).max(1024).default([]),
    // Every fragment ships an adversarial conformance suite (design bucket §1). The
    // suite id is required at the spec level; its execution is ds-3/ds-4.
    conformanceSuiteId: z.string().min(1).max(200),
  })
  .strict();
export type DesignFragmentSpecV1 = z.infer<typeof DesignFragmentSpecV1>;

export function parseDesignFragmentSpec(value: unknown): DesignFragmentSpecV1 {
  return parseOrThrow("fragment-spec", DesignFragmentSpecV1, value);
}
