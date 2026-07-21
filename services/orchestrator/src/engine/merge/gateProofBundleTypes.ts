import type { CasByteStore, Digest, ProofSubstrate } from "../contracts/cas.js";
import type { IntegrationNodeMember } from "../contracts/integrationNodes.js";
import type { GateProofBundleV2, GateSectionKind, RequiredSectionPlan } from "../contracts/gateProof.js";
import type { GateVerdict } from "../contracts/mergeAuthority.js";

/** The real native-gate observation returned by `batchNodeGate`, before V2 sealing. */
export interface NativeCiGateObservation {
  readonly gateConfigHash: string;
  readonly tiers: readonly string[];
  readonly steps: readonly { readonly name: string; readonly tier: string; readonly passed: boolean }[];
  readonly junit: { readonly total: number; readonly failures: number; readonly skipped: number };
  readonly verdict: GateVerdict;
}

export interface GateProofBundleInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly members: readonly IntegrationNodeMember[];
  readonly gateConfigHash: string;
  readonly policyVersion: string;
  readonly nativeCi: NativeCiGateObservation;
}

export interface GateProofRequirements {
  readonly plan: RequiredSectionPlan;
  /** Every run id with a declared behavior that the pre-merge behavior gate requires. */
  readonly runtimeBehaviorRunIds: readonly string[];
}

export interface RequiredGateSection {
  readonly kind: GateSectionKind;
  readonly subjectId: string;
}

export interface GateProofBundleSealer {
  seal(input: GateProofBundleInput): Promise<GateProofBundleV2>;
  /** Reuse only a sealed, exact V2 bundle; a missing V2 proof is never a pass. */
  findExact(input: Omit<GateProofBundleInput, "nativeCi">): Promise<GateProofBundleV2 | undefined>;
}

export interface GateProofBundleVerifier {
  verifyExact(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly nodeId: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly memberSetHash: string;
    readonly members: readonly IntegrationNodeMember[];
    readonly gateConfigHash: string;
    readonly policyVersion: string;
    readonly gateProofBundleId: string;
    readonly proofBundleDigest: Digest;
    readonly proofRoot: Digest;
  }): Promise<boolean>;
}

export interface GateProofBundleStoreDeps {
  readonly proofSubstrate: ProofSubstrate;
  /** Stores the exact head/tree artifact whose digest is sealed into SP-3. */
  readonly cas: CasByteStore;
}
