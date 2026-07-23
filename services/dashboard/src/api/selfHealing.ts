/**
 * bh-14b — the Self-Healing surface's typed contract with the orchestrator.
 *
 * Two read shapes:
 *  1. the org-scoped funnel (`GET /v1/orgs/:orgId/self-healing/funnel`) — the
 *     reproduce → fix → merge → deploy → symptom-verify → source-close counts plus
 *     one summary row per issue loop; and
 *  2. the bh-14a sealed resolution-proof chain (`GET …/issue-loops/:loopId/proof`)
 *     — the six SEPARATE truth badges + the causal evidence sections rendered as
 *     the loop-detail graph.
 *
 * The six badges are parsed as independent fields and NEVER OR'd into a single
 * pass/fail: a cosmetic fix keeps its demo badge green while its symptom badge is
 * red, and the schema preserves exactly that split.
 */

import { z } from "zod";

export const SELF_HEALING_STAGES = [
  "opened",
  "reproduced",
  "fixed",
  "merged",
  "deployed",
  "symptom_verified",
  "source_closed",
] as const;
export type SelfHealingStage = (typeof SELF_HEALING_STAGES)[number];

/** The six independent truth badges (bh-14a). Kept as separate string fields. */
export const ProofBadgesSchema = z.object({
  gate: z.string(),
  merged: z.string(),
  deploy: z.string(),
  demo: z.string(),
  symptom: z.string(),
  source: z.string(),
});
export type ProofBadges = z.infer<typeof ProofBadgesSchema>;

const FunnelCountsSchema = z.object({
  opened: z.number().int().nonnegative(),
  reproduced: z.number().int().nonnegative(),
  fixed: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  deployed: z.number().int().nonnegative(),
  symptom_verified: z.number().int().nonnegative(),
  source_closed: z.number().int().nonnegative(),
});
export type FunnelCounts = z.infer<typeof FunnelCountsSchema>;

const LoopSummarySchema = z.object({
  loopId: z.string(),
  projectId: z.string(),
  state: z.string(),
  severity: z.string(),
  fingerprint: z.string(),
  furthestStage: z.enum(SELF_HEALING_STAGES),
  hasProof: z.boolean(),
  terminal: z.string().nullable(),
  badges: ProofBadgesSchema.nullable(),
});
export type LoopSummary = z.infer<typeof LoopSummarySchema>;

export const SelfHealingFunnelSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  funnel: z.object({
    counts: FunnelCountsSchema,
    loops: z.array(LoopSummarySchema),
    totalLoops: z.number().int().nonnegative(),
  }),
});
export type SelfHealingFunnel = z.infer<typeof SelfHealingFunnelSchema>;

// --- The bh-14a proof chain (loop-detail causal graph + badges) ----------------

const SpecOriginSchema = z.object({
  id: z.string(),
  specId: z.string(),
  role: z.string(),
  attemptNumber: z.number().nullable(),
  ordinal: z.number().nullable(),
});

const EvidenceRunSchema = z
  .object({
    verificationRunId: z.string(),
    artifactDigest: z.string().nullable(),
    classification: z.string().nullable(),
    runtimeBehaviorContextHash: z.string().nullish(),
  })
  .nullable();

const ProductionSymptomSchema = z
  .object({
    verificationRunId: z.string(),
    classification: z.string().nullable(),
    outcome: z.enum(["passed", "failed", "inconclusive"]),
    artifactDigest: z.string().nullable(),
    probedUrl: z.string().nullable(),
    assertions: z.array(z.object({ id: z.string(), outcome: z.string() })),
    runtimeBehaviorContextHash: z.string().nullish(),
  })
  .nullable();

const ProofSectionsSchema = z.object({
  issue_loop: z.object({
    issueLoopId: z.string(),
    fingerprint: z.string().nullable(),
    sourceRevision: z.string().nullable(),
    providerObjectId: z.string().nullable(),
  }),
  triage: z.object({ taskId: z.string(), status: z.string().nullable() }).nullable(),
  spec_origins: z.array(SpecOriginSchema),
  merge: z.object({ mergeSha: z.string(), authorityAuditId: z.string().nullable() }).nullable(),
  deployment: z
    .object({
      releaseInstanceId: z.string(),
      artifactDigest: z.string().nullable(),
      url: z.string().nullable(),
      state: z.string().nullable(),
    })
    .nullable(),
  baseline: EvidenceRunSchema,
  counterfactual: EvidenceRunSchema,
  production_symptom: ProductionSymptomSchema,
  resolution_decision: z.object({
    decisionId: z.string(),
    decision: z.enum(["authorized", "blocked", "needs_attention", "waived"]),
    authorityVersion: z.string(),
  }),
  source_sync: z.object({ outboxId: z.string(), operation: z.string(), state: z.string() }).nullable(),
});

const SealedProofSchema = z.object({
  version: z.string(),
  terminal: z.string(),
  issueLoopId: z.string(),
  badges: ProofBadgesSchema,
  proofHash: z.string(),
  evidence: z.object({ sections: ProofSectionsSchema }),
});

const PersistedProofSchema = z.object({
  id: z.string(),
  terminal: z.string(),
  sealedAt: z.string(),
  proof: SealedProofSchema,
  verification: z.object({
    valid: z.boolean(),
    divergedAt: z.string().nullable(),
    recomputedProofHash: z.string(),
  }),
});
export type PersistedProof = z.infer<typeof PersistedProofSchema>;
export type ProofSections = z.infer<typeof ProofSectionsSchema>;

export const LoopProofResponseSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  loopId: z.string(),
  proofs: z.array(PersistedProofSchema),
});
export type LoopProofResponse = z.infer<typeof LoopProofResponseSchema>;
