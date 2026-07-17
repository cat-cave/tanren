import { z } from "zod";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SubjectKind = z.enum(["run", "change", "activation"]);

// Mission-complete WAVE-5 shared vocabulary freeze (mq-11/gv-9/ds-2/in-4).
// Values are stable identifiers and content digests only; raw policy bodies,
// materialization diagnostics, and exported artifact bytes remain out of events.
export const wave5EventRegistry = {
  "governance.binding.activated": z
    .object({
      projectId: z.string(),
      bindingId: z.string(),
      tierId: z.string(),
      policyRevisionId: z.string(),
      effectivePolicyHash: Sha256,
    })
    .strict(),
  "governance.effective_policy.recorded": z
    .object({
      projectId: z.string(),
      snapshotId: z.string(),
      bindingId: z.string(),
      tierId: z.string(),
      policyRevisionId: z.string(),
      effectivePolicyHash: Sha256,
      subjectKind: SubjectKind,
      subjectId: z.string(),
      inputsDigest: Sha256,
    })
    .strict(),
  "governance.binding.superseded": z
    .object({
      projectId: z.string(),
      bindingId: z.string(),
      supersededByBindingId: z.string(),
      tierId: z.string(),
    })
    .strict(),
  "integration.node.materialized": z
    .object({
      projectId: z.string(),
      integrationNodeId: z.string(),
      memberKey: z.string(),
      baseSha: z.string(),
      headSha: z.string(),
      treeHash: Sha256,
    })
    .strict(),
  "integration.node.materialization_failed": z
    .object({
      projectId: z.string(),
      memberKey: z.string(),
      baseSha: z.string(),
      failureCode: z.string(),
      diagnosticsDigest: Sha256,
    })
    .strict(),
  "design.artifact.published": z
    .object({
      projectId: z.string(),
      artifactId: z.string(),
      releaseId: z.string(),
      artifactDigest: Sha256,
    })
    .strict(),
  "design.catalog.built": z
    .object({
      projectId: z.string(),
      catalogId: z.string(),
      catalogDigest: Sha256,
      artifactIds: z.array(z.string()),
    })
    .strict(),
  "design.export.produced": z
    .object({
      projectId: z.string(),
      artifactId: z.string(),
      exportId: z.string(),
      format: z.string(),
      outputDigest: Sha256,
    })
    .strict(),
} as const;
