// rv-23 — the STABLE, versioned response contract for the runtime-verification
// DASHBOARD read surfaces (the "visible" in provable/callable/visible). rv-22
// already publishes run listings, run detail + verdicts, and per-behavior verdict
// history; this node adds the aggregate + governance surfaces the dashboard needs
// that rv-22 does not cover: the Behavior Proof Matrix (one row per behavior
// revision), the external-effect causality summary, the design-render (visual)
// verdicts, the merge-queue regression bisections, and the flake-quarantine
// current state.
//
// Every field is named + typed here once, mirroring rv-22's contract.ts style.
// The surface exposes proof state AS IT IS — "reachable" and "behavior proven"
// are DISTINCT: a behavior with no verdict, zero executed assertions, or no
// result is surfaced as UNPROVEN (never laundered into passed), and a failed /
// inconclusive outcome is a first-class member of the outcome enum.

import { z } from "zod";

/** The frozen version tag every response carries. Bump to `v2` on a breaking change. */
export const RV_DASHBOARD_SURFACE_VERSION = "v1" as const;

// --- Closed string sets (mirror the DB CHECK constraints) ---------------------
export const BehaviorVerdictOutcome = z.enum([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
export const FlakeState = z.enum(["stable", "suspected", "confirmed", "quarantined_fragment"]);
export const BehaviorRevisionStatus = z.enum(["active", "superseded", "needs_respec"]);
export const EffectClassification = z.enum(["ok", "missing", "duplicate"]);
export const DesignRenderOutcome = z.enum(["passed", "failed_visual", "inconclusive_infrastructure", "not_applicable"]);
export const BisectionStatus = z.enum(["localized", "inconclusive"]);
export const QuarantineState = z.enum(["quarantined", "released"]);

// --- Behavior Proof Matrix ----------------------------------------------------

/** The latest verdict of a given purpose class (preview vs production) for a behavior. */
export const MatrixVerdictCell = z
  .object({
    outcome: BehaviorVerdictOutcome,
    requiredAssertionCount: z.number().int().nonnegative(),
    executedAssertionCount: z.number().int().nonnegative(),
    flakeState: FlakeState,
    artifactDigest: z.string().min(1),
    runId: z.string().min(1),
    createdAt: z.coerce.date(),
  })
  .strict();
export type MatrixVerdictCell = z.infer<typeof MatrixVerdictCell>;

/**
 * One row of the matrix — a behavior revision + its distilled proof state. A null
 * preview/production cell means NO verdict of that class exists yet: the row is
 * UNPROVEN for that plane, which the view renders red/unknown, never green.
 */
export const BehaviorProofMatrixRow = z
  .object({
    behaviorRevisionId: z.string().min(1),
    behaviorId: z.string().min(1),
    title: z.string(),
    revisionNumber: z.number().int().positive(),
    status: BehaviorRevisionStatus,
    designContractDigest: z.string().nullable(),
    owningSpecIds: z.array(z.string().min(1)),
    latestPreview: MatrixVerdictCell.nullable(),
    latestProduction: MatrixVerdictCell.nullable(),
    lastProvenArtifactDigest: z.string().nullable(),
    quarantined: z.boolean(),
    verdictCount: z.number().int().nonnegative(),
  })
  .strict();
export type BehaviorProofMatrixRow = z.infer<typeof BehaviorProofMatrixRow>;

export const BehaviorProofMatrix = z
  .object({
    version: z.literal(RV_DASHBOARD_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    rows: z.array(BehaviorProofMatrixRow),
  })
  .strict();
export type BehaviorProofMatrix = z.infer<typeof BehaviorProofMatrix>;

// --- External-effect causality summary ----------------------------------------

export const EffectObservationView = z
  .object({
    observationId: z.string().min(1),
    observer: z.string().min(1),
    provider: z.string().min(1),
    classification: EffectClassification,
    triggerIdHash: z.string().nullable(),
    providerObjectHash: z.string().nullable(),
    occurrenceCount: z.number().int().nonnegative(),
    latencyMs: z.number().int().nullable(),
    cursor: z.string().nullable(),
    createdAt: z.coerce.date(),
  })
  .strict();
export type EffectObservationView = z.infer<typeof EffectObservationView>;

export const EffectCausalitySummary = z
  .object({
    version: z.literal(RV_DASHBOARD_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    okCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    observations: z.array(EffectObservationView),
  })
  .strict();
export type EffectCausalitySummary = z.infer<typeof EffectCausalitySummary>;

// --- Design-render (visual) verdicts ------------------------------------------

export const DesignRenderVerdictView = z
  .object({
    id: z.string().min(1),
    designSystemId: z.string().min(1),
    releaseId: z.string().min(1),
    designContractVersion: z.string().min(1),
    contractDigest: z.string().nullable(),
    accessibilityStandard: z.string().min(1),
    outcome: DesignRenderOutcome,
    checkpointCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    inconclusiveCount: z.number().int().nonnegative(),
    failingScenarioKey: z.string().nullable(),
    failingRuleIds: z.array(z.string()),
    createdAt: z.coerce.date(),
  })
  .strict();
export type DesignRenderVerdictView = z.infer<typeof DesignRenderVerdictView>;

export const DesignRenderVerdictList = z
  .object({
    version: z.literal(RV_DASHBOARD_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    verdicts: z.array(DesignRenderVerdictView),
  })
  .strict();
export type DesignRenderVerdictList = z.infer<typeof DesignRenderVerdictList>;

// --- Merge-queue regression bisections ----------------------------------------

export const RegressionBisectionView = z
  .object({
    id: z.string().min(1),
    behaviorRevisionId: z.string().min(1),
    status: BisectionStatus,
    failingReleaseInstanceId: z.string().min(1),
    failingVerdictId: z.string().min(1),
    baselineReleaseInstanceId: z.string().nullable(),
    culpritReleaseInstanceId: z.string().nullable(),
    culpritIntegrationNodeId: z.string().nullable(),
    inconclusiveReason: z.string().nullable(),
    candidateCount: z.number().int().nonnegative(),
    probeCount: z.number().int().nonnegative(),
    createdAt: z.coerce.date(),
  })
  .strict();
export type RegressionBisectionView = z.infer<typeof RegressionBisectionView>;

export const RegressionBisectionList = z
  .object({
    version: z.literal(RV_DASHBOARD_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    bisections: z.array(RegressionBisectionView),
  })
  .strict();
export type RegressionBisectionList = z.infer<typeof RegressionBisectionList>;

// --- Flake / quarantine current state -----------------------------------------

export const QuarantineView = z
  .object({
    behaviorRevisionId: z.string().min(1),
    state: QuarantineState,
    transitionId: z.string().min(1),
    classification: z.string().min(1),
    gateEffect: z.string().min(1),
    reason: z.string(),
    actor: z.string().min(1),
    contextHash: z.string().min(1),
    evidenceVerdictCount: z.number().int().nonnegative(),
    createdAt: z.coerce.date(),
  })
  .strict();
export type QuarantineView = z.infer<typeof QuarantineView>;

export const FlakeQuarantineList = z
  .object({
    version: z.literal(RV_DASHBOARD_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    quarantines: z.array(QuarantineView),
  })
  .strict();
export type FlakeQuarantineList = z.infer<typeof FlakeQuarantineList>;
