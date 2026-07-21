import { z } from "zod";

export const runtimeOutcomeSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    id: z.string().min(1),
    authorityDecisionId: z.string().min(1).optional(),
    effectIntentId: z.string().min(1).optional(),
    gateProofBundleId: z.string().min(1),
    proofBundleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    proofRoot: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    quarantineVersion: z.string().min(1),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    treeHash: z.string().min(1),
    memberSetHash: z.string().min(1),
    members: z
      .array(
        z
          .object({
            specId: z.string().min(1),
            runId: z.string().min(1),
            branch: z.string().min(1),
            headSha: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    gateConfigHash: z.string().min(1),
    policyVersion: z.string().min(1),
    runnerImage: z.string().min(1),
    appEnvHash: z.string().min(1),
    decision: z.enum(["authorized", "blocked", "needs_attention"]),
    result: z.enum(["landed", "declined", "quarantined"]),
    mainSha: z.string().min(1).optional(),
  })
  .strict();
