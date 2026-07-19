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
}

export interface BindingWriteResult {
  readonly ok: boolean;
  readonly status: number;
  readonly binding?: ProjectDesignBinding;
  readonly message?: string;
}
