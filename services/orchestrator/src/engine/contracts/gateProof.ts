/**
 * SP-7 owns the gate-proof PROFILE over SP-3; never a parallel
 * root/signature/byte store; GateSectionKind's single public module.
 * Every consumer imports from ./gateProof.js.
 */

import { z } from "zod";
import type { Digest } from "./cas.js";
import type { ProofReuseKeyInput } from "./integrationNodes.js";
import type { GateVerdict } from "./mergeAuthority.js";

export type GateSectionKind = "native_ci" | "runtime_behavior" | "design_render" | "artifact_provenance";

export const GATE_SECTION_KINDS = ["native_ci", "runtime_behavior", "design_render", "artifact_provenance"] as const;

export const CANONICAL_SECTION_ORDER = [
  "native_ci",
  "runtime_behavior",
  "design_render",
  "artifact_provenance",
] as const;

export const NativeCiBodySchema = z
  .object({
    gateConfigHash: z.string().min(1),
    when: z.enum(["per_iteration", "pre_audit", "pre_merge"]),
    headSha: z.string().min(1),
    tiers: z.array(z.string()),
    steps: z.array(
      z
        .object({
          name: z.string(),
          tier: z.string(),
          passed: z.boolean(),
        })
        .strict(),
    ),
    junit: z
      .object({
        total: z.number().int().min(0),
        failures: z.number().int().min(0),
        skipped: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type NativeCiBody = z.infer<typeof NativeCiBodySchema>;

export const RuntimeBehaviorBodySchema = z
  .object({
    runtimeBehaviorContextHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    requiredBehaviorRevisionCount: z.number().int().min(0),
    verdictMerkleRoot: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    executedAssertionTotal: z.number().int().min(0),
    behaviorVerdicts: z.array(
      z
        .object({
          behaviorRevisionId: z.string().min(1),
          verdict: z.enum(["passed", "failed", "unknown"]),
          executedAssertionCount: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();

export type RuntimeBehaviorBody = z.infer<typeof RuntimeBehaviorBodySchema>;

export const DesignRenderBodySchema = z
  .object({
    designContractVersions: z.array(z.string().min(1)),
    checkpointCount: z.number().int().min(0),
    renderVerdicts: z.array(
      z
        .object({
          checkpointId: z.string().min(1),
          verdict: z.enum(["passed", "failed", "unknown"]),
          // OPTIONAL: the browser-free a11y/DOM verdict (ds-4 sub-node #3) carries NO pixel
          // diff — it is omitted, never faked. The render-worker (browser) sub-node sets it
          // for the pixel path. A present value is a real, nonnegative diff ratio.
          diffRatio: z.number().min(0).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type DesignRenderBody = z.infer<typeof DesignRenderBodySchema>;

export const ArtifactProvenanceBodySchema = z
  .object({
    artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    previewDeploymentFingerprint: z.string().min(1),
    integrationEvidenceCount: z.number().int().min(0),
    a11yFindingCount: z.number().int().min(0),
    provenanceAttestationDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict();

export type ArtifactProvenanceBody = z.infer<typeof ArtifactProvenanceBodySchema>;

export const GATE_SECTION_BODY_SCHEMAS: Readonly<Record<GateSectionKind, z.ZodType>> = {
  native_ci: NativeCiBodySchema,
  runtime_behavior: RuntimeBehaviorBodySchema,
  design_render: DesignRenderBodySchema,
  artifact_provenance: ArtifactProvenanceBodySchema,
};

export interface RequiredSectionPlan {
  readonly required: Readonly<Record<GateSectionKind, boolean>>;
}

export interface GateSectionVerdict {
  readonly kind: GateSectionKind;
  readonly required: boolean;
  readonly verdict: GateVerdict;
  readonly unitDigests: readonly Digest[];
}

export interface GateProofBundleV2 {
  readonly gateProofBundleId: string;
  /** SP-3 bundle identity; the projection stores no duplicate signature or bytes. */
  readonly proofBundleDigest: Digest;
  /** The only proof coordinate a land envelope may carry. */
  readonly proofRoot: Digest;
  readonly integrationNodeId: string;
  /** The full proof-reuse identity carried by the sealed SP-3 coordinate. */
  readonly proofKeyInput: ProofReuseKeyInput;
  readonly plan: RequiredSectionPlan;
  readonly sections: readonly GateSectionVerdict[];
  /** Exact runtime-behavior body coordinates available on a freshly sealed bundle. */
  readonly runtimeBehaviorBindings?: readonly RuntimeBehaviorBinding[];
  readonly gateVerdict: GateVerdict;
}

export interface RuntimeBehaviorBinding {
  readonly planSetHash: Digest;
  readonly requiredBehaviorRevisionCount: number;
}

export function orderSections(sections: readonly GateSectionVerdict[]): readonly GateSectionVerdict[] {
  return [...sections].sort(
    (a, b) => CANONICAL_SECTION_ORDER.indexOf(a.kind) - CANONICAL_SECTION_ORDER.indexOf(b.kind),
  );
}

export function aggregateGateVerdict(plan: RequiredSectionPlan, sections: readonly GateSectionVerdict[]): GateVerdict {
  let hasUnknownOrMissing = false;

  for (const kind of CANONICAL_SECTION_ORDER) {
    if (!plan.required[kind]) {
      continue;
    }

    const section = sections.find((candidate) => candidate.kind === kind);
    if (section === undefined || section.verdict === "unknown") {
      hasUnknownOrMissing = true;
      continue;
    }
    if (section.verdict === "failed") {
      return "failed";
    }
  }

  return hasUnknownOrMissing ? "unknown" : "passed";
}
