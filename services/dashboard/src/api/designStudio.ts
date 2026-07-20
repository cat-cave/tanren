// ds-5 — dashboard-side wire schemas for the design Studio / reuse / evidence /
// exports surface. These mirror the orchestrator contract
// (routes/designStudio/contract.ts) so the client can reject a mismatched or
// laundered payload (200-only + safeParse + scope-id match) before rendering.

import { z } from "zod";

export const DS_STUDIO_SURFACE_VERSION = "v1" as const;

const CatalogReleaseSummarySchema = z.object({
  releaseId: z.string(),
  version: z.number().int(),
  contractDigest: z.string(),
  canonicalArtifactId: z.string(),
  publishedAt: z.string(),
});

export const DesignSystemCatalogEntrySchema = z.object({
  designSystemId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  lifecycle: z.string(),
  defaultChannel: z.string(),
  publishedReleaseCount: z.number().int(),
  latestPublishedRelease: CatalogReleaseSummarySchema.nullable(),
  channels: z.array(z.object({ channel: z.string(), releaseId: z.string() })),
  reuseCount: z.number().int(),
});

export const DesignCatalogResponseSchema = z.object({
  version: z.literal(DS_STUDIO_SURFACE_VERSION),
  orgId: z.string(),
  systems: z.array(DesignSystemCatalogEntrySchema),
});

export const ProjectDesignBindingSchema = z.object({
  projectId: z.string(),
  designSystemId: z.string(),
  pinMode: z.enum(["release", "channel"]),
  pinnedReleaseId: z.string().nullable(),
  channel: z.string().nullable(),
  boundBy: z.string(),
  updatedAt: z.string(),
});

export const DesignBindingResponseSchema = z.object({
  version: z.literal(DS_STUDIO_SURFACE_VERSION),
  orgId: z.string(),
  projectId: z.string(),
  binding: ProjectDesignBindingSchema.nullable(),
});

export const DesignEvidenceVerdictSchema = z.object({
  outcome: z.enum(["passed", "failed_visual", "inconclusive_infrastructure", "not_applicable"]),
  accessibilityStandard: z.string(),
  designContractVersion: z.string(),
  releaseId: z.string(),
  contractDigest: z.string().nullable(),
  failingScenarioKey: z.string().nullable(),
  failingRuleIds: z.array(z.string()),
  checkpointCount: z.number().int(),
  checkpoints: z.array(
    z.object({
      checkpointId: z.string(),
      verdict: z.enum(["passed", "failed", "unknown"]),
      failingRuleIds: z.array(z.string()),
      diffRatio: z.number().optional(),
      screenshotDigest: z.string().optional(),
    }),
  ),
});

export const DesignEvidenceResponseSchema = z.object({
  version: z.literal(DS_STUDIO_SURFACE_VERSION),
  orgId: z.string(),
  projectId: z.string(),
  verdict: DesignEvidenceVerdictSchema.nullable(),
});

export const DesignExportsResponseSchema = z.object({
  version: z.literal(DS_STUDIO_SURFACE_VERSION),
  orgId: z.string(),
  artifactId: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      mediaType: z.string(),
      digest: z.string(),
      byteSize: z.number().int(),
      href: z.string(),
    }),
  ),
});

// ds-6 — the DesignDeliveryProofV1 delivery-trace wire schema (A4 ≡ demo). Read-only; a
// laundered/partial payload is rejected by safeParse before rendering. `equivalence` is the
// closed-vocab DERIVED verdict — the client never receives (nor sends) a success boolean.
export const DesignDeliveryEquivalenceSchema = z.enum([
  "equivalent",
  "blocked_pre_merge_incomplete",
  "blocked_no_live_release",
  "blocked_artifact_mismatch",
  "blocked_scenario_mismatch",
  "blocked_node_mismatch",
  "blocked_render_not_passed",
  "blocked_demo_not_passed",
  "blocked_deploy_unverified",
]);

export const DesignDeliveryProofSchema = z.object({
  version: z.literal(1),
  schemaVersion: z.literal("design_delivery_proof.v1"),
  orgId: z.string(),
  projectId: z.string(),
  runId: z.string(),
  integrationNodeId: z.string(),
  equivalence: DesignDeliveryEquivalenceSchema,
  preMerge: z
    .object({
      integrationNodeId: z.string(),
      proofRoot: z.string(),
      releaseId: z.string(),
      designSystemId: z.string(),
      contractDigest: z.string(),
      designContractVersion: z.string(),
      renderOutcome: z.enum(["passed", "failed_visual", "inconclusive_infrastructure", "not_applicable"]),
      adapterTarget: z.string(),
      artifactDigest: z.string(),
      scenarioKeys: z.array(z.string()),
      cells: z.array(
        z.object({
          scenarioKey: z.string(),
          renderVerdict: z.enum(["passed", "failed", "unknown"]),
          screenshotDigest: z.string().optional(),
          designProofKey: z.string(),
          proofUnitId: z.string(),
          reused: z.boolean(),
        }),
      ),
    })
    .nullable(),
  production: z
    .object({
      releaseInstanceId: z.string(),
      integrationNodeId: z.string(),
      provider: z.string(),
      environment: z.literal("production"),
      deploymentId: z.string(),
      artifactDigest: z.string(),
      sourceRef: z.string(),
      behaviorCount: z.number().int(),
      behaviorsPassed: z.number().int(),
      behaviorsFailed: z.number().int(),
      scenarioKeys: z.array(z.string()),
    })
    .nullable(),
  boundKey: z
    .object({
      releaseDigest: z.string(),
      fragmentDigests: z.array(z.string()),
      adapterTarget: z.string(),
      environment: z.string(),
      scenarioKey: z.string(),
      artifactDigest: z.string(),
    })
    .nullable(),
});

export const DesignDeliveryResponseSchema = z.object({
  version: z.literal(DS_STUDIO_SURFACE_VERSION),
  orgId: z.string(),
  projectId: z.string(),
  proof: DesignDeliveryProofSchema,
});

export type DesignDeliveryProof = z.infer<typeof DesignDeliveryProofSchema>;

export type DesignSystemCatalogEntry = z.infer<typeof DesignSystemCatalogEntrySchema>;
export type ProjectDesignBinding = z.infer<typeof ProjectDesignBindingSchema>;
export type DesignEvidenceVerdict = z.infer<typeof DesignEvidenceVerdictSchema>;
export type DesignExportsResponse = z.infer<typeof DesignExportsResponseSchema>;
export type DesignExportFile = DesignExportsResponse["files"][number];

/** The Studio screen's composed, already-fail-closed read model. A field left
 * `undefined` means the orchestrator did not return a valid response for it → the
 * view renders that section BLOCKED, never a fabricated empty. */
export interface DesignStudioView {
  readonly systems: readonly DesignSystemCatalogEntry[] | undefined;
  readonly binding: ProjectDesignBinding | null | undefined;
  readonly evidence: DesignEvidenceVerdict | null | undefined;
  readonly exports: readonly DesignExportFile[] | undefined;
  /** ds-6 — the verified-join delivery trace (A4 ≡ demo); `undefined` ⇒ BLOCKED section. */
  readonly delivery: DesignDeliveryProof | undefined;
}

export interface BindingWriteResult {
  readonly ok: boolean;
  readonly status: number;
  readonly binding?: ProjectDesignBinding;
  readonly message?: string;
}
