/**
 * SP-5 runtime-verification: the driver/observer/render adapter surface, the
 * verdict vocabulary, and the emitted proof-unit draft shapes. Split out of
 * runtimeVerification.ts to keep each contract module under the 500-line ceiling;
 * re-exported by ./runtimeVerification.ts so the public import specifier is
 * unchanged. SP-5 EMITS evidence only — no adapter here calls an authority.
 */

import type { CanonicalBody, CasArtifactRef, Digest, ProofUnitDraft, ProviderChecksum } from "./cas.js";
import type { BehaviorRevisionId } from "./behaviorRevision.js";
import type { DesignRenderBody, RuntimeBehaviorBody } from "./gateProof.js";
import type {
  BehaviorVerificationPlanId,
  DesignCheckpointRef,
  ExampleRow,
  ExecutableBehaviorPlanV1,
  ExecutionMatrix,
  RedactionClass,
  VerificationArtifactId,
} from "./runtimeVerificationPlan.js";

export type BehaviorVerdictOutcome =
  | "passed"
  | "failed_product"
  | "failed_verification_contract"
  | "failed_visual"
  | "inconclusive_infrastructure"
  | "inconclusive_external"
  | "cancelled_superseded";
export type FlakeState = "stable" | "suspected" | "confirmed" | "quarantined_fragment";
export type VerificationRunPurpose =
  | "per_iteration"
  | "pre_audit"
  | "pre_merge"
  | "release_periodic"
  | "post_merge_production"
  | "manual_canary";
export type RenderVerdictOutcome = "passed" | "failed_visual" | "inconclusive_infrastructure";

export interface AdapterUnavailableResult {
  readonly kind: "unavailable";
  readonly outcome: "inconclusive_external" | "inconclusive_infrastructure";
  readonly reason: string;
}

export interface PreviewArtifactResult {
  readonly kind: "built";
  readonly artifactDigest: Digest;
  readonly artifact: CasArtifactRef;
}

export interface PreviewDeploymentResult {
  readonly kind: "deployed";
  readonly artifactDigest: Digest;
  readonly deploymentFingerprint: string;
  readonly previewUrl?: string;
}

export interface PreviewDeploymentAdapter {
  buildArtifact(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly sourceRevision: string;
  }): Promise<PreviewArtifactResult | AdapterUnavailableResult>;
  deployPreview(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly artifactDigest: Digest;
  }): Promise<PreviewDeploymentResult | AdapterUnavailableResult>;
  /** Promotion consumes the supplied artifact and never rebuilds it. */
  promote(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly artifactDigest: Digest;
    readonly deploymentFingerprint: string;
  }): Promise<PreviewDeploymentResult | AdapterUnavailableResult>;
  rollback(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly deploymentFingerprint: string;
  }): Promise<{ readonly kind: "rolled_back"; readonly deploymentFingerprint: string } | AdapterUnavailableResult>;
  teardown(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly deploymentFingerprint: string;
  }): Promise<{ readonly kind: "torn_down"; readonly deploymentFingerprint: string } | AdapterUnavailableResult>;
}

export interface DriverExecutionInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly plan: ExecutableBehaviorPlanV1;
  readonly matrix: ExecutionMatrix;
  readonly example: ExampleRow;
  readonly deploymentFingerprint: string;
}

export interface DriverObservation {
  readonly observationKind: string;
  readonly subject: string;
  readonly value: CanonicalBody;
  readonly observedAt: string;
}

export interface DriverExecutionResult {
  readonly kind: "executed";
  readonly observations: readonly DriverObservation[];
  readonly providerChecksums: readonly ProviderChecksum[];
  /**
   * rv-9: the REAL run artifact(s) the drive produced — e.g. the captured HTTP
   * response(s) or rendered output — surfaced as raw evidence bytes so the
   * acceptance run's render-capture stage can content-address them into the
   * verification-artifact store. Absent ⇒ the surface produced no artifact to
   * capture (the drive is unaffected; only evidence linkage is skipped). The
   * bytes MUST be deterministic given identical observed output so identical
   * content dedupes to one content address.
   */
  readonly capture?: readonly EvidenceBytePayload[];
}

export interface BrowserDriverAdapter {
  execute(
    input: DriverExecutionInput & { readonly browser: string; readonly viewport: string },
  ): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}
export interface ApiDriverAdapter {
  execute(
    input: DriverExecutionInput & { readonly baseUrl: string },
  ): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}
export interface CliDriverAdapter {
  execute(
    input: DriverExecutionInput & { readonly executable: string },
  ): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}
export interface PackageDriverAdapter {
  execute(
    input: DriverExecutionInput & { readonly packageRef: string },
  ): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}
export interface MobileDriverAdapter {
  execute(
    input: DriverExecutionInput & { readonly device: string },
  ): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}

export interface FixtureLease {
  readonly leaseId: string;
  readonly expiresAt: string;
  readonly cleanupScope: string;
}

export interface CleanupReceipt {
  readonly leaseId: string;
  readonly cleanedResourceCount: number;
  readonly receiptDigest: Digest;
}

export interface FixtureLeaseAdapter {
  acquire(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly planId: BehaviorVerificationPlanId;
    readonly fixtureParams: CanonicalBody;
  }): Promise<FixtureLease | AdapterUnavailableResult>;
  release(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly leaseId: string;
  }): Promise<CleanupReceipt | AdapterUnavailableResult>;
}

export interface SideEffectObservation {
  readonly provider: string;
  readonly providerObjectHash: string;
  readonly cursorWatermark: string;
  readonly occurrenceCount: number;
  readonly monotonic: boolean;
  readonly providerReceiptChecksums: readonly ProviderChecksum[];
}

export interface SideEffectObserverAdapter {
  /** Slack-first observer contract; bodies, tokens, and message text are never returned. */
  captureCursor(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly provider: string;
  }): Promise<{ readonly provider: string; readonly cursorWatermark: string } | AdapterUnavailableResult>;
  observeSince(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly provider: string;
    readonly cursorWatermark: string;
    readonly triggerIdHash: string;
  }): Promise<SideEffectObservation | AdapterUnavailableResult>;
}

export type RenderEvidenceKind = "screenshot" | "dom" | "computed_styles" | "a11y_tree" | "console" | "network";
export interface EvidenceBytePayload {
  readonly kind: RenderEvidenceKind;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly redactionClass: RedactionClass;
}

export interface RenderCaptureAdapter {
  capture(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly checkpoint: DesignCheckpointRef;
    readonly deploymentFingerprint: string;
  }): Promise<
    { readonly kind: "captured"; readonly evidence: readonly EvidenceBytePayload[] } | AdapterUnavailableResult
  >;
}

export interface VisualComparisonRules {
  readonly imageDiffThreshold: number;
  readonly layoutTolerance: number;
  readonly tokenRules: readonly string[];
  readonly contrastMinimum: number;
  readonly semanticRules: readonly string[];
}

export interface VisualVerdictAdapter {
  compare(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly actual: CasArtifactRef;
    readonly baseline: CasArtifactRef | null;
    readonly rules: VisualComparisonRules;
  }): Promise<
    | {
        readonly outcome: RenderVerdictOutcome;
        readonly diffArtifact: CasArtifactRef | null;
        readonly diffRatio: number;
        readonly ruleResults: readonly CanonicalBody[];
      }
    | AdapterUnavailableResult
  >;
}

export interface EvidenceLinkRef {
  readonly verificationArtifactId: VerificationArtifactId;
  readonly casDigest: Digest;
  readonly mediaType: string;
  readonly proofUnitDigest?: Digest;
}

/** These aliases make the SP-7 section-body constraint visible at the SP-5 seam. */
export type RuntimeBehaviorProofUnitDraft = Omit<ProofUnitDraft, "kind" | "body"> & {
  readonly kind: "runtime_behavior";
  readonly body: RuntimeBehaviorBody;
};
export type DesignRenderProofUnitDraft = Omit<ProofUnitDraft, "kind" | "body"> & {
  readonly kind: "design_render";
  readonly body: DesignRenderBody;
};

export interface RenderVerdictRecord {
  readonly checkpointId: string;
  readonly designContractVersion: string;
  readonly outcome: RenderVerdictOutcome;
  readonly diffRatio: number;
  readonly diffArtifactDigest?: Digest;
}

export interface RuntimeBehaviorProofResult {
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly caseId: string;
  readonly matrixKey: string;
  readonly outcome: BehaviorVerdictOutcome;
  readonly requiredAssertionCount: number;
  readonly executedAssertionCount: number;
  readonly attempts: number;
  readonly flakeState: FlakeState;
  readonly artifactDigest: Digest;
  readonly deploymentFingerprint: string;
  readonly runtimeContextHash: Digest;
  readonly evidenceLinkRefs: readonly EvidenceLinkRef[];
  readonly renderVerdicts: readonly RenderVerdictRecord[];
}

/** SP-5 maps its rich outcome vocabulary to the tri-state gate-proof vocabulary. */
export function mapVerdictOutcomeToProofVerdict(outcome: BehaviorVerdictOutcome): "passed" | "failed" | "unknown" {
  switch (outcome) {
    case "passed":
      return "passed";
    case "failed_product":
    case "failed_verification_contract":
    case "failed_visual":
      return "failed";
    case "inconclusive_infrastructure":
    case "inconclusive_external":
    case "cancelled_superseded":
      return "unknown";
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled behavior verdict outcome: ${String(unreachable)}`);
    }
  }
}
