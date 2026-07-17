import { z } from "zod";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const FixtureKind = z.enum(["org", "account", "channel", "dataset"]);
const Visibility = z.enum(["public", "private"]);

// Mission-complete WAVE-6 shared vocabulary freeze (mq-6/rv-7/rv-8/gv-11).
// Payloads contain only durable identifiers, digests, classifications, and counts;
// provider bodies, cursor values, cleanup diagnostics, and credentials stay out.
export const wave6EventRegistry = {
  "fixture.lease.acquired": z
    .object({
      projectId: z.string(),
      leaseId: z.string(),
      kind: FixtureKind,
      resourceRef: z.string(),
      correlationNamespace: z.string(),
    })
    .strict(),
  "fixture.lease.released": z
    .object({
      projectId: z.string(),
      leaseId: z.string(),
      cleanupEvidenceHash: Sha256.optional(),
    })
    .strict(),
  "fixture.lease.expired": z
    .object({
      projectId: z.string(),
      leaseId: z.string(),
      kind: FixtureKind,
    })
    .strict(),
  "fixture.lease.cleanup_failed": z
    .object({
      projectId: z.string(),
      leaseId: z.string(),
      cleanupEvidenceHash: Sha256.optional(),
    })
    .strict(),
  "behavior.effect.missing": z
    .object({
      projectId: z.string(),
      observationId: z.string(),
      triggerIdHash: Sha256,
      observer: z.string(),
      provider: z.string(),
      occurrenceCount: z.number().int().nonnegative(),
    })
    .strict(),
  "behavior.effect.duplicate": z
    .object({
      projectId: z.string(),
      observationId: z.string(),
      triggerIdHash: Sha256,
      providerObjectHash: Sha256,
      observer: z.string(),
      provider: z.string(),
      occurrenceCount: z.number().int().nonnegative(),
    })
    .strict(),
  "observer.watermark.advanced": z
    .object({
      projectId: z.string(),
      observer: z.string(),
      watermarkHash: Sha256,
    })
    .strict(),
  "observer.inconclusive_external": z
    .object({
      projectId: z.string(),
      observationId: z.string(),
      observer: z.string(),
      provider: z.string(),
      cursorHash: Sha256.optional(),
    })
    .strict(),
  "integration.proof_unit.recorded": z
    .object({
      projectId: z.string(),
      proofUnitId: z.string(),
      kind: z.string(),
      subjectId: z.string(),
      inputHash: Sha256.optional(),
      artifactHash: Sha256.optional(),
      quarantineEpoch: z.number().int().nonnegative(),
    })
    .strict(),
  "integration.proof_unit.reused": z
    .object({
      projectId: z.string(),
      proofUnitId: z.string(),
      sourceNodeId: z.string().optional(),
      inputHash: Sha256.optional(),
      quarantineEpoch: z.number().int().nonnegative(),
    })
    .strict(),
  "integration.proof_root.composed": z
    .object({
      projectId: z.string(),
      integrationNodeId: z.string(),
      proofRoot: z.string(),
      proofUnitIds: z.array(z.string()),
    })
    .strict(),
  "repository.visibility.observed": z
    .object({
      projectId: z.string(),
      observationId: z.string(),
      observedVisibility: Visibility,
      forgeRef: z.string(),
      sha: z.string(),
    })
    .strict(),
  "repository.visibility.mismatch": z
    .object({
      projectId: z.string(),
      observationId: z.string(),
      expectedVisibility: Visibility,
      observedVisibility: Visibility,
      forgeRef: z.string(),
      sha: z.string(),
    })
    .strict(),
  "governance.visibility.enforced": z
    .object({
      projectId: z.string(),
      observationId: z.string(),
      visibility: Visibility,
    })
    .strict(),
} as const;
