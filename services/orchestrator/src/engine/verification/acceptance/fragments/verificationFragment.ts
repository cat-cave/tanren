// rv-3 — the verification-fragment CONTRACT: the capability citation a plan makes,
// the F2 authoring Spec/Draft/Validated shapes, the invocation context, and the
// content-addressed identity helpers.
//
// A verification fragment is a REUSABLE capability implementation (a fixture, a
// driver, an action, an assertion, an observer, a visual checkpoint, a cleanup, or
// an artifact-capture) that an executable behavior plan (rv-2) cites by a stable
// `(capabilityKey, fragmentKind)`. The registry resolves a cited capability to a
// concrete `verification_fragment_versions` row; a MISSING capability is authored
// through the shared SP-2 F2 kernel (writer→validate, fixed-point convergent) — never
// silently skipped. This file is the leaf contract both the rv-2 compiler seam and
// the rv-3 authoring binding import without a cycle (schema + pure helpers only).
//
// NO SILENT DEFAULTS: every parse is fail-closed (a malformed citation, draft, or
// context throws a typed error — never an `as` cast that reaches a runtime with a
// half-formed fragment).

import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalBody } from "../../../contracts/cas.js";
import type {
  CapabilityFragmentRef,
  RequiredSurface,
  VerificationFragmentId,
  VerificationFragmentVersionId,
} from "../../../contracts/runtimeVerificationPlan.js";

/** The rv-3 fragment contract version — part of the version-row `contract_version`
 * and cross-checked by the validator (a drift is a fail-closed rejection). */
export const VERIFICATION_FRAGMENT_CONTRACT_VERSION = "rv3-verification-fragment.v1";

/** The eight verification capability kinds — the `fragment_kind` discriminator +
 * the frozen `behavior.fragment.*` event `capability` vocabulary (SP-8). */
export const VERIFICATION_FRAGMENT_KINDS = [
  "fixture",
  "driver",
  "action",
  "assertion",
  "observer",
  "visual_checkpoint",
  "cleanup",
  "artifact_capture",
] as const;
export const VerificationFragmentKindSchema = z.enum(VERIFICATION_FRAGMENT_KINDS);
export type VerificationFragmentKind = (typeof VERIFICATION_FRAGMENT_KINDS)[number];

/** The three executable-plan step lanes a cited capability binds into. */
export const VERIFICATION_STEP_KINDS = ["fixture", "action", "cleanup"] as const;
export const VerificationStepKindSchema = z.enum(VERIFICATION_STEP_KINDS);

const CanonicalBodySchema: z.ZodType<CanonicalBody> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(CanonicalBodySchema),
    z.record(z.string(), CanonicalBodySchema),
  ]),
);

const RequiredSurfaceSchema = z.enum([
  "browser",
  "api",
  "cli",
  "package",
  "app_channel",
  "external_integration",
  "mobile",
]) satisfies z.ZodType<RequiredSurface>;

/** One capability CITATION an acceptance spec makes — the plan needs the capability
 * `(capabilityKey, fragmentKind)` bound into the `stepKind` lane at `stepId`. */
export const VerificationCapabilityCitationSchema = z
  .object({
    stepKind: VerificationStepKindSchema,
    stepId: z.string().min(1).max(200),
    capabilityKey: z.string().min(1).max(200),
    fragmentKind: VerificationFragmentKindSchema,
    surface: RequiredSurfaceSchema,
    params: CanonicalBodySchema.default(null),
  })
  .strict();
export type VerificationCapabilityCitation = z.infer<typeof VerificationCapabilityCitationSchema>;

/** The F2 authoring SPEC — the missing capability slot the writer must author. */
export interface VerificationFragmentSpecV1 {
  readonly capabilityKey: string;
  readonly fragmentKind: VerificationFragmentKind;
  readonly surface: RequiredSurface;
}

/** The stable `(fragmentKind, capabilityKey)` resolution-map + unit key. */
export function capabilityMapKey(fragmentKind: VerificationFragmentKind, capabilityKey: string): string {
  return `${fragmentKind}:${capabilityKey}`;
}

/** The per-capability unit id (org-independent; the persisted row carries the org). */
export function verificationFragmentUnitId(spec: VerificationFragmentSpecV1): string {
  return capabilityMapKey(spec.fragmentKind, spec.capabilityKey);
}

/** The writer's STRUCTURED output — a declarative capability descriptor. The source
 * is the real capability body; the descriptor names the entrypoint the runtime
 * invokes and the surface the capability drives. */
export const VerificationFragmentDraftV1 = z
  .object({
    capabilityKey: z.string().min(1).max(200),
    fragmentKind: VerificationFragmentKindSchema,
    surface: RequiredSurfaceSchema,
    version: z.string().min(1).max(128).default("1.0.0"),
    contractVersion: z.string().min(1).max(128),
    /** The exported symbol the runtime invokes to drive this capability. */
    entrypoint: z.string().min(1).max(200),
    /** The real capability source text (content-addressed by the validator). */
    source: z.string().min(1).max(1_000_000),
  })
  .strict();
export type VerificationFragmentDraftV1 = z.infer<typeof VerificationFragmentDraftV1>;

/** The validated artifact the kernel persists; a retracted unit is absent. */
export interface ValidatedVerificationFragment {
  /** Stable fragment identity per `(capabilityKey, fragmentKind)` — the reuse key. */
  readonly fragmentId: VerificationFragmentId;
  /** Content-addressed version identity of this authored body. */
  readonly fragmentVersionId: VerificationFragmentVersionId;
  readonly capabilityKey: string;
  readonly fragmentKind: VerificationFragmentKind;
  readonly surface: RequiredSurface;
  readonly version: string;
  readonly contractVersion: string;
  readonly entrypoint: string;
  /** Deterministic in-repo source path the version row records. */
  readonly sourcePath: string;
  /** `sha256:<hex>` of the canonical draft body. */
  readonly contentHash: string;
  /** The canonical JSON body persisted for the fragment version. */
  readonly canonicalBody: string;
  readonly draft: VerificationFragmentDraftV1;
}

/** Thrown when a writer body does not parse as a valid draft (fail-closed). */
export class VerificationFragmentDraftCorruptError extends Error {
  public override readonly name = "VerificationFragmentDraftCorruptError";
  public constructor(public readonly issues: string) {
    super(`verification fragment draft is corrupt: ${issues}`);
  }
}

/** Parse an unknown writer body into a typed draft (fail-closed). */
export function parseVerificationFragmentDraft(value: unknown): VerificationFragmentDraftV1 {
  const result = VerificationFragmentDraftV1.safeParse(value);
  if (!result.success) {
    throw new VerificationFragmentDraftCorruptError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
    );
  }
  return result.data;
}

/** Canonical, schema-normalized JSON for a draft — the digest + persistence body. */
export function canonicalVerificationFragmentJson(draft: VerificationFragmentDraftV1): string {
  return JSON.stringify(parseVerificationFragmentDraft(draft));
}

/** Content-address a canonical draft body (`sha256:<hex>`). */
export function verificationFragmentDigest(draft: VerificationFragmentDraftV1): string {
  return `sha256:${createHash("sha256").update(canonicalVerificationFragmentJson(draft), "utf8").digest("hex")}`;
}

/** Stable fragment identity per `(capabilityKey, fragmentKind)` — reused across
 * versions so re-resolution binds the SAME fragment and versions accumulate. */
export function verificationFragmentId(kind: VerificationFragmentKind, capabilityKey: string): string {
  return `vf:${kind}:${capabilityKey}`;
}

/** The content-addressed version id — a new body mints a new version. */
export function verificationFragmentVersionId(fragmentId: string, contentHash: string): string {
  return `${fragmentId}@${contentHash.slice("sha256:".length)}`;
}

/** The deterministic in-repo source path the version row records. */
export function verificationFragmentSourcePath(kind: VerificationFragmentKind, capabilityKey: string): string {
  return `.tanren/verification/fragments/${kind}/${capabilityKey}.ts`;
}

/** Project a validated fragment into the plan's `CapabilityFragmentRef` (the bind). */
export function toCapabilityFragmentRef(validated: ValidatedVerificationFragment): CapabilityFragmentRef {
  return {
    fragmentId: validated.fragmentId,
    fragmentVersionId: validated.fragmentVersionId,
    capabilityKey: validated.capabilityKey,
    fragmentKind: validated.fragmentKind,
  };
}

/** The rv-3 authoring invocation context (fail-closed; an unscoped run must never
 * persist off-tenant rows). */
export const VerificationFragmentAuthoringContext = z
  .object({
    orgId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    behaviorRevisionId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256).optional(),
    specId: z.string().min(1).max(256).optional(),
    createdBy: z.string().min(1).max(256).default("tanren.rv3"),
  })
  .strict();
export type VerificationFragmentAuthoringContext = z.infer<typeof VerificationFragmentAuthoringContext>;

export class VerificationFragmentAuthoringContextError extends Error {
  public override readonly name = "VerificationFragmentAuthoringContextError";
  public constructor(public readonly issues: string) {
    super(`verification fragment authoring context is invalid: ${issues}`);
  }
}

export function parseVerificationFragmentAuthoringContext(value: unknown): VerificationFragmentAuthoringContext {
  const result = VerificationFragmentAuthoringContext.safeParse(value);
  if (!result.success) {
    throw new VerificationFragmentAuthoringContextError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
    );
  }
  return result.data;
}
