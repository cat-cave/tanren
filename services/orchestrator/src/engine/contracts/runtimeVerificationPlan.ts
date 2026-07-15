/**
 * SP-5 runtime-verification: the executable-behavior plan surface — branded row
 * identities, the assertion algebra, the plan shape, and the versioned
 * runtime-context / plan domainHash keys. Split out of runtimeVerification.ts to
 * keep each contract module under the 500-line ceiling; re-exported by
 * ./runtimeVerification.ts so the public import specifier is unchanged.
 */

import type { CanonicalBody, Digest } from "./cas.js";
import { domainHash } from "./cas.js";
import type { BehaviorRevisionId, PersonaRevisionId, RevisionDigest } from "./behaviorRevision.js";

/** Branded row identities owned by the runtime-verification substrate. */
export type BehaviorVerificationPlanId = string & { readonly __brand: "BehaviorVerificationPlanId" };
export type VerificationFragmentId = string & { readonly __brand: "VerificationFragmentId" };
export type VerificationFragmentVersionId = string & { readonly __brand: "VerificationFragmentVersionId" };
export type VerificationEnvironmentId = string & { readonly __brand: "VerificationEnvironmentId" };
export type BehaviorVerificationRunId = string & { readonly __brand: "BehaviorVerificationRunId" };
export type BehaviorVerificationAttemptId = string & { readonly __brand: "BehaviorVerificationAttemptId" };
export type BehaviorVerdictId = string & { readonly __brand: "BehaviorVerdictId" };
export type BehaviorAssertionObservationId = string & { readonly __brand: "BehaviorAssertionObservationId" };
export type BehaviorEffectObservationId = string & { readonly __brand: "BehaviorEffectObservationId" };
export type VerificationArtifactId = string & { readonly __brand: "VerificationArtifactId" };
export type DesignRenderVerdictId = string & { readonly __brand: "DesignRenderVerdictId" };
export type BehaviorQuarantineId = string & { readonly __brand: "BehaviorQuarantineId" };
export type BehaviorCoverageEdgeId = string & { readonly __brand: "BehaviorCoverageEdgeId" };

export type RequiredSurface = "browser" | "api" | "cli" | "package" | "app_channel" | "external_integration" | "mobile";

export interface SourceSpan {
  readonly sourcePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface CapabilityFragmentRef {
  readonly fragmentId: VerificationFragmentId;
  readonly fragmentVersionId: VerificationFragmentVersionId;
  readonly capabilityKey: string;
  readonly fragmentKind: string;
}

export interface FixtureStep {
  readonly id: string;
  readonly capabilityFragmentRef: CapabilityFragmentRef;
  readonly params: CanonicalBody;
  readonly sourceSpan: SourceSpan;
}

export interface ActionStep {
  readonly id: string;
  readonly capabilityFragmentRef: CapabilityFragmentRef;
  readonly params: CanonicalBody;
  readonly sourceSpan: SourceSpan;
}

export interface CleanupStep {
  readonly id: string;
  readonly capabilityFragmentRef: CapabilityFragmentRef;
  readonly params: CanonicalBody;
  readonly sourceSpan: SourceSpan;
}

export type RedactionClass = "none" | "secret" | "credential" | "token" | "pii" | "sensitive" | "hash_only";

export type ComparisonOperator =
  | "equals"
  | "not_equals"
  | "less_than"
  | "less_than_or_equal"
  | "greater_than"
  | "greater_than_or_equal"
  | "between"
  | "matches_schema"
  | "satisfies_predicate"
  | "contains"
  | "not_contains"
  | "has_cardinality"
  | "is_unique"
  | "exactly_once"
  | "eventually"
  | "before"
  | "after"
  | "causes"
  | "responds_with"
  | "matches"
  | "has_no_effect";

interface AssertionBase {
  readonly assertionId: string;
  readonly subject: string;
  readonly expected: CanonicalBody;
  readonly comparisonOperator: ComparisonOperator;
  readonly redactionClass: RedactionClass;
}

export type AssertionExpression =
  | (AssertionBase & { readonly kind: "scalar_equality" })
  | (AssertionBase & { readonly kind: "scalar_order"; readonly order: "ascending" | "descending" })
  | (AssertionBase & { readonly kind: "scalar_range"; readonly inclusive: boolean })
  | (AssertionBase & { readonly kind: "scalar_schema"; readonly schema: CanonicalBody })
  | (AssertionBase & { readonly kind: "scalar_predicate"; readonly predicate: string })
  | (AssertionBase & { readonly kind: "set_cardinality"; readonly cardinality: number })
  | (AssertionBase & { readonly kind: "set_uniqueness" })
  | (AssertionBase & { readonly kind: "set_exactly_once"; readonly expectedOccurrence: CanonicalBody })
  | (AssertionBase & {
      readonly kind: "temporal_eventual";
      readonly providerCursor: string;
      readonly watermark: string;
    })
  | (AssertionBase & { readonly kind: "temporal_order"; readonly providerCursor: string; readonly watermark: string })
  | (AssertionBase & { readonly kind: "causal_for_every"; readonly trigger: string; readonly effect: string })
  | (AssertionBase & { readonly kind: "causal_exactly_one"; readonly trigger: string; readonly effect: string })
  | (AssertionBase & {
      readonly kind: "http";
      readonly method: string;
      readonly path: string;
      readonly statusCode: number;
    })
  | (AssertionBase & { readonly kind: "dom"; readonly selector: string; readonly property: string })
  | (AssertionBase & { readonly kind: "accessibilityTree"; readonly role: string; readonly name?: string })
  | (AssertionBase & {
      readonly kind: "databaseObserver";
      readonly queryKey: string;
      readonly consistency: "snapshot" | "read_committed";
    })
  | (AssertionBase & { readonly kind: "externalProvider"; readonly provider: string; readonly objectType: string })
  | (AssertionBase & { readonly kind: "visual_image"; readonly baselineKey: string })
  | (AssertionBase & { readonly kind: "visual_layout"; readonly baselineKey: string })
  | (AssertionBase & { readonly kind: "visual_token"; readonly tokenName: string })
  | (AssertionBase & { readonly kind: "visual_contrast"; readonly foreground: string; readonly background: string })
  | (AssertionBase & { readonly kind: "visual_semantic"; readonly semanticRule: string })
  | (AssertionBase & { readonly kind: "negative"; readonly forbiddenEffect: string })
  | (AssertionBase & { readonly kind: "counterfactual"; readonly alternateInput: CanonicalBody });

export interface ExampleRow {
  readonly values: readonly (string | number | boolean | null)[];
  readonly rowHash: Digest;
}

export interface ExecutionMatrix {
  readonly browser: readonly string[];
  readonly viewport: readonly string[];
  readonly locale: readonly string[];
  readonly theme: readonly string[];
  readonly motion: readonly string[];
  readonly contrast: readonly string[];
  readonly device: readonly string[];
}

export interface DesignCheckpointRef {
  readonly designContractId: string;
  readonly designContractVersion: string;
  readonly checkpointKey: string;
  readonly state: string;
}

export interface ArtifactPolicy {
  readonly retainEvidence: boolean;
  readonly evidenceKinds: readonly (
    | "trace"
    | "screenshot"
    | "video"
    | "dom"
    | "a11y"
    | "provider_receipt"
    | "console"
    | "network"
  )[];
  readonly retentionClass: string;
  readonly maxBytesPerArtifact: number;
  readonly requireRedaction: boolean;
}

export interface FlakePolicy {
  /** Integer retry count; this is not a timeout. */
  readonly retries: number;
  /** Integer stress repetition count; this is not a timeout. */
  readonly stressRepetitions: number;
  /** Integer number of passing repetitions required for stability. */
  readonly stablePassThreshold: number;
}

export interface PlanProvenance {
  readonly compilerVersion: string;
  readonly behaviorRevisionHash: RevisionDigest;
  readonly forgeProvenanceIds: readonly string[];
}

export interface ExecutableBehaviorPlanV1 {
  readonly version: "v1";
  readonly planId: BehaviorVerificationPlanId;
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly personaRevisionId: PersonaRevisionId;
  readonly requiredSurfaces: readonly RequiredSurface[];
  readonly fixtures: readonly FixtureStep[];
  readonly actions: readonly ActionStep[];
  readonly assertions: readonly AssertionExpression[];
  readonly cleanup: readonly CleanupStep[];
  readonly examples: readonly ExampleRow[];
  readonly executionMatrix: ExecutionMatrix;
  readonly designCheckpoints: readonly DesignCheckpointRef[];
  readonly artifactPolicy: ArtifactPolicy;
  readonly flakePolicy: FlakePolicy;
  readonly provenance: PlanProvenance;
}

export interface MissingCapabilityObligation {
  readonly capability: string;
  readonly fragmentKind: string;
  readonly reason: string;
}

export type ExecutableBehaviorPlanCanonical = CanonicalBody;

export type PlanCompileResult =
  | { readonly kind: "compiled"; readonly plan: ExecutableBehaviorPlanV1; readonly planHash: Digest }
  | { readonly kind: "needs_respec"; readonly reasons: readonly string[] }
  | { readonly kind: "missing_fragments"; readonly obligations: readonly MissingCapabilityObligation[] };

/** Set-semantic arrays must be sorted by the caller; domainHash sorts object keys but preserves array order. */
export interface RuntimeBehaviorContextComponents {
  readonly requiredBehaviorRevisionHashes: readonly RevisionDigest[];
  readonly planHashes: readonly Digest[];
  readonly fragmentVersionHashes: readonly string[];
  readonly compilerVersion: string;
  readonly designContractVersions: readonly string[];
  readonly artifactDigest: Digest;
  readonly deploymentFingerprint: string;
  readonly fixtureAndGrantFingerprint: string;
  readonly adapterVersions: readonly string[];
  readonly browserDeviceVersions: readonly string[];
  readonly secretVersionIds: readonly string[];
  readonly policyHash: string;
}

export interface RuntimeBehaviorContextBody {
  readonly [key: string]: CanonicalBody;
  readonly requiredBehaviorRevisionHashes: readonly RevisionDigest[];
  readonly planHashes: readonly Digest[];
  readonly fragmentVersionHashes: readonly string[];
  readonly compilerVersion: string;
  readonly designContractVersions: readonly string[];
  readonly artifactDigest: Digest;
  readonly deploymentFingerprint: string;
  readonly fixtureAndGrantFingerprint: string;
  readonly adapterVersions: readonly string[];
  readonly browserDeviceVersions: readonly string[];
  readonly secretVersionIds: readonly string[];
  readonly policyHash: string;
}

/** Hashes the versioned runtime proof-unit context; this is never a seventh proofReuseKey component. */
export function runtimeBehaviorContextHash(components: RuntimeBehaviorContextComponents): Digest {
  const body: RuntimeBehaviorContextBody = { ...components };
  return domainHash("runtime_behavior_context.v1", body);
}

export function planHash(planBody: ExecutableBehaviorPlanCanonical): Digest {
  return domainHash("plan.v1", planBody);
}
