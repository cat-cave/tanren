// rv-23 — the dashboard-side WIRE schemas for the runtime-verification proof
// surfaces. These mirror the orchestrator's stable read contracts
// (routes/proofDashboard/contract.ts for the 5 new surfaces; runtimeVerification/
// contract.ts for the two rv-22 surfaces the Behavior-detail and Run-detail views
// reuse). Decoding is fail-closed: a response that does not parse exactly collapses
// to `undefined` at the client boundary, so the view renders an explicit
// unavailable state rather than fabricating a green proof.

import { z } from "zod";

export const OUTCOME = z.enum([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
export type Outcome = z.infer<typeof OUTCOME>;

const FLAKE = z.enum(["stable", "suspected", "confirmed", "quarantined_fragment"]);

// --- Behavior Proof Matrix ----------------------------------------------------
const MatrixVerdictCellSchema = z.object({
  outcome: OUTCOME,
  requiredAssertionCount: z.number(),
  executedAssertionCount: z.number(),
  flakeState: FLAKE,
  artifactDigest: z.string(),
  runId: z.string(),
  createdAt: z.string(),
});

const BehaviorProofMatrixRowSchema = z.object({
  behaviorRevisionId: z.string(),
  behaviorId: z.string(),
  title: z.string(),
  revisionNumber: z.number(),
  status: z.enum(["active", "superseded", "needs_respec"]),
  designContractDigest: z.string().nullable(),
  owningSpecIds: z.array(z.string()),
  latestPreview: MatrixVerdictCellSchema.nullable(),
  latestProduction: MatrixVerdictCellSchema.nullable(),
  lastProvenArtifactDigest: z.string().nullable(),
  quarantined: z.boolean(),
  verdictCount: z.number(),
});

export const BehaviorProofMatrixSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  rows: z.array(BehaviorProofMatrixRowSchema),
});
export type BehaviorProofMatrix = z.infer<typeof BehaviorProofMatrixSchema>;

// --- External-effect causality ------------------------------------------------
const EffectObservationSchema = z.object({
  observationId: z.string(),
  observer: z.string(),
  provider: z.string(),
  classification: z.enum(["ok", "missing", "duplicate"]),
  triggerIdHash: z.string().nullable(),
  providerObjectHash: z.string().nullable(),
  occurrenceCount: z.number(),
  latencyMs: z.number().nullable(),
  cursor: z.string().nullable(),
  createdAt: z.string(),
});

export const EffectCausalitySchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  okCount: z.number(),
  missingCount: z.number(),
  duplicateCount: z.number(),
  observations: z.array(EffectObservationSchema),
});
export type EffectCausality = z.infer<typeof EffectCausalitySchema>;

// --- Design-render (visual) verdicts ------------------------------------------
const DesignRenderVerdictSchema = z.object({
  id: z.string(),
  designSystemId: z.string(),
  releaseId: z.string(),
  designContractVersion: z.string(),
  contractDigest: z.string().nullable(),
  accessibilityStandard: z.string(),
  outcome: z.enum(["passed", "failed_visual", "inconclusive_infrastructure", "not_applicable"]),
  checkpointCount: z.number(),
  passedCount: z.number(),
  failedCount: z.number(),
  inconclusiveCount: z.number(),
  failingScenarioKey: z.string().nullable(),
  failingRuleIds: z.array(z.string()),
  createdAt: z.string(),
});

export const DesignRenderListSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  verdicts: z.array(DesignRenderVerdictSchema),
});
export type DesignRenderList = z.infer<typeof DesignRenderListSchema>;

// --- Merge-queue regression bisections ----------------------------------------
const RegressionBisectionSchema = z.object({
  id: z.string(),
  behaviorRevisionId: z.string(),
  status: z.enum(["localized", "inconclusive"]),
  failingReleaseInstanceId: z.string(),
  failingVerdictId: z.string(),
  baselineReleaseInstanceId: z.string().nullable(),
  culpritReleaseInstanceId: z.string().nullable(),
  culpritIntegrationNodeId: z.string().nullable(),
  inconclusiveReason: z.string().nullable(),
  candidateCount: z.number(),
  probeCount: z.number(),
  createdAt: z.string(),
});

export const RegressionBisectionListSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  bisections: z.array(RegressionBisectionSchema),
});
export type RegressionBisectionList = z.infer<typeof RegressionBisectionListSchema>;

// --- Flake / quarantine current state -----------------------------------------
const QuarantineSchema = z.object({
  behaviorRevisionId: z.string(),
  state: z.enum(["quarantined", "released"]),
  transitionId: z.string(),
  classification: z.string(),
  gateEffect: z.string(),
  reason: z.string(),
  actor: z.string(),
  contextHash: z.string(),
  evidenceVerdictCount: z.number(),
  createdAt: z.string(),
});

export const FlakeQuarantineListSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  quarantines: z.array(QuarantineSchema),
});
export type FlakeQuarantineList = z.infer<typeof FlakeQuarantineListSchema>;

// --- rv-22 reuse: run detail (assertion timeline) + behavior verdict history ---
const VerdictViewSchema = z.object({
  verdictId: z.string(),
  behaviorRevisionId: z.string(),
  outcome: OUTCOME,
  requiredAssertionCount: z.number(),
  executedAssertionCount: z.number(),
  attemptCount: z.number(),
  flakeState: FLAKE,
  gateEffect: z.enum(["blocking", "advisory"]),
  artifactDigest: z.string(),
  proofUnitDigest: z.string().nullable(),
  runtimeBehaviorContextHash: z.string(),
});

const RunHeaderSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  purpose: z.enum([
    "per_iteration",
    "pre_audit",
    "pre_merge",
    "release_periodic",
    "post_merge_production",
    "manual_canary",
  ]),
  status: z.enum(["planned", "running", "completed", "failed", "cancelled"]),
  specId: z.string().nullable(),
  integrationNodeId: z.string().nullable(),
  environmentId: z.string(),
  artifactDigest: z.string(),
  createdAt: z.string(),
  verdictCount: z.number(),
  latestOutcome: OUTCOME.nullable(),
});

export const RunDetailSchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  run: RunHeaderSchema,
  environment: z
    .object({
      environmentId: z.string(),
      projectId: z.string(),
      integrationNodeId: z.string(),
      artifactDigest: z.string(),
      deploymentTarget: z.string(),
      environmentFingerprint: z.string(),
      lifecycleStatus: z.enum(["provisioning", "ready", "torn_down", "failed"]),
    })
    .nullable(),
  verdicts: z.array(VerdictViewSchema),
  proofBundleHref: z.string(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const BehaviorVerdictHistorySchema = z.object({
  version: z.literal("v1"),
  orgId: z.string(),
  projectId: z.string(),
  behaviorRevisionId: z.string(),
  latestOutcome: OUTCOME.nullable(),
  verdicts: z.array(
    z.object({
      runId: z.string(),
      runPurpose: z.string(),
      runStatus: z.string(),
      createdAt: z.string(),
      verdict: VerdictViewSchema,
    }),
  ),
});
export type BehaviorVerdictHistory = z.infer<typeof BehaviorVerdictHistorySchema>;
