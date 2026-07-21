import { z } from "zod";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const wave4EventRegistry = {
  "symptom.baseline.started": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      contractId: z.string(),
      verificationRunId: z.string(),
    })
    .strict(),
  "symptom.baseline.observed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      contractId: z.string(),
      verificationRunId: z.string(),
      outcome: z.enum(["reproduced", "not_reproduced", "inconclusive"]),
      evidenceArtifactIds: z.array(z.string()),
    })
    .strict(),
  "symptom.assertion.recorded": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      verificationRunId: z.string(),
      assertionId: z.string(),
      expectedHash: Sha256,
      observedHash: Sha256,
      outcome: z.enum(["passed", "failed", "inconclusive"]),
      timingMs: z.number().int().nonnegative(),
    })
    .strict(),
  "source.finding.recorded": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      sourceFindingId: z.string(),
      sourceId: z.string(),
      providerRevision: z.string(),
    })
    .strict(),
  "source.sync.pending": z
    .object({
      issueLoopId: z.string(),
      outboxId: z.string(),
      sourceId: z.string(),
      operation: z.string(),
      payloadHash: Sha256,
    })
    .strict(),
  "source.sync.verified": z
    .object({
      issueLoopId: z.string(),
      outboxId: z.string(),
      sourceId: z.string(),
      operation: z.string(),
      payloadHash: Sha256,
    })
    .strict(),
  "source.sync.externally_closed_unverified": z
    .object({
      issueLoopId: z.string(),
      outboxId: z.string(),
      sourceId: z.string(),
      observedRevision: z.string(),
    })
    .strict(),
  "merge.group.formed": z
    .object({
      projectId: z.string(),
      groupId: z.string(),
      partitionId: z.string(),
      baseSha: z.string(),
      memberKeys: z.array(z.string()),
      policyHash: Sha256,
    })
    .strict(),
  "merge.land_group.completed": z
    .object({
      projectId: z.string(),
      landGroupId: z.string(),
      decisionId: z.string(),
      expectedMainSha: z.string(),
      authorizedSha: z.string(),
      mainSha: z.string(),
      memberKeys: z.array(z.string()),
    })
    .strict(),
  "merge.train.artifact.sealed": z
    .object({
      projectId: z.string(),
      landGroupId: z.string(),
      authorityDecisionId: z.string(),
      integrationNodeId: z.string(),
      proofRoot: Sha256,
      bundleId: z.string(),
      bundleDigest: Sha256,
      bytesDigest: Sha256,
      signingKeyId: z.string(),
      contentHash: Sha256,
    })
    .strict(),
  "merge.land_group.delivery.completed": z
    .object({
      projectId: z.string(),
      landGroupId: z.string(),
      mainSha: z.string(),
      artifactDigest: Sha256,
      productionReleaseInstanceId: z.string(),
      memberCount: z.number().int().nonnegative(),
      receiptId: z.string(),
    })
    .strict(),
  "merge.land_group.delivery.failed": z
    .object({
      projectId: z.string(),
      landGroupId: z.string(),
      mainSha: z.string(),
      state: z.enum(["preview_failed", "rolled_back", "needs_attention"]),
      disposition: z.enum(["none", "repair_routed", "needs_attention"]),
      reason: z.string(),
    })
    .strict(),
  "governance.tier.created": z
    .object({
      projectId: z.string(),
      tierId: z.string(),
      tierName: z.string(),
      preset: z.string(),
      canonicalHash: Sha256,
    })
    .strict(),
  "governance.tier.activated": z
    .object({
      projectId: z.string(),
      tierId: z.string(),
      tierName: z.string(),
      policyBindingId: z.string(),
      effectivePolicyHash: Sha256,
    })
    .strict(),
} as const;
