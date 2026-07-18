/**
 * SP-5 runtime-verification harness contract — the public module (import from
 * './runtimeVerification.js'). It re-exports the plan surface
 * (./runtimeVerificationPlan.js) and the adapter/verdict surface
 * (./runtimeVerificationAdapters.js), then declares the harness, the org-scoped
 * repository, the fail-loud error family, and the SP-7 gate-body aliases.
 *
 * SP-5 EMITS evidence only: it submits canonical ProofUnitDrafts to SP-3 (the
 * sole byte store / unit sealer) and persists composite link rows — it never
 * calls an authority and never adds a field to SP-4's AuthorizeLandInput.
 */

import type { CasByteStore, Digest, ProofSubstrate, ProofUnitDraft, ProofUnitRef } from "./cas.js";
import type { BehaviorRevisionId } from "./behaviorRevision.js";
import type { DesignRenderBody, GateSectionKind, RuntimeBehaviorBody } from "./gateProof.js";
import type { CanonicalBody } from "./cas.js";
import type {
  BehaviorVerdictOutcome,
  ApiDriverAdapter,
  BrowserDriverAdapter,
  CliDriverAdapter,
  FixtureLeaseAdapter,
  FlakeState,
  MobileDriverAdapter,
  PackageDriverAdapter,
  PreviewDeploymentAdapter,
  RenderCaptureAdapter,
  RenderVerdictOutcome,
  RuntimeBehaviorProofResult,
  SideEffectObserverAdapter,
  VerificationRunPurpose,
  VisualVerdictAdapter,
} from "./runtimeVerificationAdapters.js";
import type {
  BehaviorAssertionObservationId,
  BehaviorCoverageEdgeId,
  BehaviorEffectObservationId,
  BehaviorQuarantineId,
  BehaviorVerdictId,
  BehaviorVerificationAttemptId,
  BehaviorVerificationPlanId,
  BehaviorVerificationRunId,
  ComparisonOperator,
  DesignRenderVerdictId,
  ExecutableBehaviorPlanV1,
  MissingCapabilityObligation,
  PlanCompileResult,
  RedactionClass,
  VerificationArtifactId,
  VerificationEnvironmentId,
  VerificationFragmentVersionId,
} from "./runtimeVerificationPlan.js";

export * from "./runtimeVerificationPlan.js";
export * from "./runtimeVerificationAdapters.js";
export * from "./runtimeVerificationInvariants.js";

export interface RuntimeVerificationHarness {
  readonly casByteStore: CasByteStore;
  readonly proofSubstrate: ProofSubstrate;
  readonly previewDeployment: PreviewDeploymentAdapter;
  readonly fixtureLease: FixtureLeaseAdapter;
  readonly sideEffectObserver: SideEffectObserverAdapter;
  readonly renderCapture: RenderCaptureAdapter;
  readonly visualVerdict: VisualVerdictAdapter;
  readonly browser?: BrowserDriverAdapter;
  readonly api?: ApiDriverAdapter;
  readonly cli?: CliDriverAdapter;
  readonly package?: PackageDriverAdapter;
  readonly mobile?: MobileDriverAdapter;
  execute(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly runId: BehaviorVerificationRunId;
    readonly plans: readonly ExecutableBehaviorPlanV1[];
    readonly runtimeContextHash: Digest;
  }): Promise<readonly RuntimeBehaviorProofResult[]>;
  /** Emits only runtime_behavior and design_render drafts; SP-3 ingests them. */
  emitDrafts(results: readonly RuntimeBehaviorProofResult[]): readonly ProofUnitDraft[];
}

export interface VerificationScope {
  readonly orgId: string;
  readonly projectId: string;
}

export interface RuntimeVerificationRepository {
  upsertPlan(
    scope: VerificationScope,
    input: {
      readonly plan: ExecutableBehaviorPlanV1;
      readonly planHash: Digest;
      readonly status: PlanCompileResult["kind"];
      readonly unresolvedCapabilities: readonly MissingCapabilityObligation[];
    },
  ): Promise<BehaviorVerificationPlanId>;
  recordRun(
    scope: VerificationScope,
    input: {
      readonly purpose: VerificationRunPurpose;
      readonly runId?: string;
      readonly specId?: string;
      readonly integrationNodeId?: string;
      readonly environmentId: VerificationEnvironmentId;
      readonly preparedHeadSha: string;
      readonly jjTreeId: string;
      readonly planSetHash: Digest;
      readonly runtimeBehaviorContextHash: Digest;
      readonly artifactDigest: Digest;
    },
  ): Promise<BehaviorVerificationRunId>;
  recordAttempt(
    scope: VerificationScope,
    input: {
      readonly runId: BehaviorVerificationRunId;
      readonly behaviorRevisionId: BehaviorRevisionId;
      readonly planId: BehaviorVerificationPlanId;
      readonly exampleHash: string;
      readonly matrixHash: string;
      readonly shard: number;
      readonly seed: string;
      readonly replayOf?: BehaviorVerificationAttemptId;
      readonly outcome: BehaviorVerdictOutcome;
      readonly classification: string;
      readonly startedAt: string;
      readonly finishedAt?: string;
      readonly failureSignature?: string;
      readonly artifactManifestDigest?: Digest;
    },
  ): Promise<BehaviorVerificationAttemptId>;
  /**
   * Impls MUST call {@link assertVerdictAssertionCoverage} on the input before
   * persistence so a passed verdict with executed < required (or required < 1)
   * fails loud, matching the 0079 behavior_verdicts DB CHECKs.
   */
  recordVerdict(
    scope: VerificationScope,
    input: {
      readonly runId: BehaviorVerificationRunId;
      readonly behaviorRevisionId: BehaviorRevisionId;
      readonly exampleHash: string;
      readonly matrixHash: string;
      readonly requiredAssertionCount: number;
      readonly executedAssertionCount: number;
      readonly outcome: BehaviorVerdictOutcome;
      readonly attemptCount: number;
      readonly flakeState: FlakeState;
      readonly gateEffect: "blocking" | "advisory";
      readonly artifactDigest: Digest;
      readonly proofUnitDigest?: Digest;
      readonly runtimeBehaviorContextHash: Digest;
    },
  ): Promise<BehaviorVerdictId>;
  recordAssertionObservation(
    scope: VerificationScope,
    input: {
      readonly attemptId: BehaviorVerificationAttemptId;
      readonly assertionKind: string;
      readonly comparisonOperator: ComparisonOperator;
      readonly expected: CanonicalBody;
      readonly actual: CanonicalBody;
      readonly temporalSemantics: string;
      readonly redactionClass: RedactionClass;
      readonly passed: boolean;
    },
  ): Promise<BehaviorAssertionObservationId>;
  recordEffectObservation(
    scope: VerificationScope,
    input: {
      readonly attemptId: BehaviorVerificationAttemptId;
      readonly triggerIdHash: string;
      readonly observerProvider: string;
      readonly providerObjectHash: string;
      readonly cursorWatermark: string;
      readonly occurrenceCount: number;
      readonly latencyMs?: number;
      readonly duplicateClassification: "unique" | "duplicate" | "missing";
    },
  ): Promise<BehaviorEffectObservationId>;
  linkEvidence(
    scope: VerificationScope,
    input: {
      readonly producingAttemptId?: BehaviorVerificationAttemptId;
      readonly casDigest: Digest;
      readonly proofUnitDigest?: Digest;
      readonly kind: string;
      readonly mediaType: string;
      readonly byteSize: number;
      readonly redactionClass: RedactionClass;
      readonly retentionClass: string;
    },
  ): Promise<VerificationArtifactId>;
  recordDesignRenderVerdict(
    scope: VerificationScope,
    input: {
      readonly behaviorRevisionId: BehaviorRevisionId;
      readonly designContractId: string;
      readonly checkpointKey: string;
      readonly matrixHash: string;
      readonly actualDigest: Digest;
      readonly baselineDigest?: Digest;
      readonly diffDigest?: Digest;
      readonly domDigest?: Digest;
      readonly a11yDigest?: Digest;
      readonly ruleResults: readonly CanonicalBody[];
      readonly outcome: RenderVerdictOutcome;
      readonly designOracleFindingRef?: string;
      readonly proofUnitDigest?: Digest;
    },
  ): Promise<DesignRenderVerdictId>;
  recordCoverageEdge(
    scope: VerificationScope,
    input: {
      readonly behaviorRevisionId: BehaviorRevisionId;
      readonly edgeKind: "spec" | "source" | "component" | "integration" | "design" | "dependency";
      readonly targetRef: string;
    },
  ): Promise<BehaviorCoverageEdgeId>;
  createQuarantine(
    scope: VerificationScope,
    input: {
      readonly behaviorRevisionId: BehaviorRevisionId;
      readonly fragmentVersionId?: VerificationFragmentVersionId;
      readonly matrixScope: string;
      readonly evidenceRef: string;
      readonly owner: string;
      readonly reason: string;
      readonly expiry: string;
      readonly exitCriteria: string;
      readonly replacementProofVerdictId?: BehaviorVerdictId;
      readonly repairSpecId?: string;
    },
  ): Promise<BehaviorQuarantineId>;
  closeQuarantine(
    scope: VerificationScope,
    input: {
      readonly quarantineId: BehaviorQuarantineId;
      readonly replacementProofVerdictId: BehaviorVerdictId;
      readonly closedAt: string;
    },
  ): Promise<BehaviorQuarantineId>;
}

export class AmbiguousBehaviorPlanError extends Error {
  public override readonly name = "AmbiguousBehaviorPlanError";
  public constructor(message: string) {
    super(message);
  }
}
export class MissingVerificationFragmentError extends Error {
  public override readonly name = "MissingVerificationFragmentError";
  public constructor(message: string) {
    super(message);
  }
}
export class ZeroExecutedAssertionsError extends Error {
  public override readonly name = "ZeroExecutedAssertionsError";
  public constructor(message: string) {
    super(message);
  }
}
export class VisualBaselineLaunderingError extends Error {
  public override readonly name = "VisualBaselineLaunderingError";
  public constructor(message: string) {
    super(message);
  }
}
export class AdapterUnavailableError extends Error {
  public override readonly name = "AdapterUnavailableError";
  public constructor(message: string) {
    super(message);
  }
}

export type RuntimeBehaviorGateBody = RuntimeBehaviorBody;
export type DesignRenderGateBody = DesignRenderBody;
export type RuntimeVerificationSectionKind = Extract<GateSectionKind, "runtime_behavior" | "design_render">;
export type ProofUnitReference = ProofUnitRef;
