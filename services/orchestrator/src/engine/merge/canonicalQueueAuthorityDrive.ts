// The sole queue-to-land handoff for every exact authorized integration node.
// `PgBatchChecker` materializes and proves the node through driveBatchThroughNode
// before this is reached. This class accepts only that frozen exact binding and
// delegates the irreversible group CAS to the existing Pg land implementation.

// cspell:ignore rederive
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import { memberKey, proofReuseKey } from "../contracts/integrationNodes.js";
import type { AuthorizeLandInput, LandBindingEnvelope, LandSubject } from "../contracts/mergeAuthority.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import {
  batchArtifactDigest,
  batchProofRoot,
  type AuthorizedSubsetEvaluation,
  type BatchAuthorityEvaluator,
  type LandGroupLandOutcome,
} from "./multiMemberAuthorityTypes.js";

export interface CanonicalQueueAuthorityLandInput {
  readonly projectId: string;
  readonly entries: ReadonlyArray<MergeQueueEntry>;
  readonly binding: BatchAuthorityBinding;
  readonly evaluation: AuthorizedSubsetEvaluation;
  /** Re-proves queue ownership/policy immediately before the host CAS. */
  readonly confirmBeforeLand: () => Promise<boolean>;
}

/**
 * Canonical cardinality-one-or-greater authority drive. It deliberately owns no
 * authorization rule and no host capability: the frozen decision is created by
 * the existing exact-node evaluator and `landAuthorizedGroupPg` remains the sole
 * V2/PgLandGroupStore handoff. Any mismatch is re-derived rather than delegated.
 */
export class CanonicalQueueAuthorityDrive {
  constructor(private readonly evaluator: BatchAuthorityEvaluator) {}

  async land(input: CanonicalQueueAuthorityLandInput): Promise<LandGroupLandOutcome> {
    if (this.evaluator.landAuthorizedGroup === undefined || !hasExactCanonicalBinding(input)) {
      return { kind: "rederive" };
    }
    return this.evaluator.landAuthorizedGroup(input);
  }
}

function hasExactCanonicalBinding(input: CanonicalQueueAuthorityLandInput): boolean {
  const { binding, entries, evaluation } = input;
  const { authorization, decisionInput } = evaluation;
  const envelope = authorization.envelope;
  return (
    entries.length > 0 &&
    authorization.decision === "authorized" &&
    sameSubject(decisionInput, authorization.subject, envelope, binding) &&
    exactMembers(entries, binding, envelope) &&
    binding.memberSetHash ===
      memberKey(
        binding.baseSha,
        binding.members.map((member) => member.headSha),
      ) &&
    binding.proof.verdict === "passed" &&
    hasExactProofIdentity(binding) &&
    nonBlankString(binding.gateConfigHash) &&
    nonBlankString(binding.proof.gateProofBundleId) &&
    envelope.headSha === binding.headSha &&
    envelope.expectedMainSha === binding.baseSha &&
    envelope.memberSetHash === binding.memberSetHash &&
    envelope.policyVersion === binding.policyVersion &&
    envelope.artifactDigest === batchArtifactDigest(binding) &&
    envelope.proofRoot === batchProofRoot(binding)
  );
}

function hasExactProofIdentity(binding: BatchAuthorityBinding): boolean {
  const key = binding.proof.keyInput;
  return (
    key.memberKey === binding.memberSetHash &&
    key.gateConfigHash === binding.gateConfigHash &&
    key.policyVersion === binding.policyVersion &&
    [
      key.memberKey,
      key.gateConfigHash,
      key.policyVersion,
      key.runnerImage,
      key.appEnvHash,
      key.quarantineVersion,
    ].every((value) => nonBlankString(value)) &&
    nonBlankString(proofReuseKey(key))
  );
}

function sameSubject(
  decisionInput: AuthorizeLandInput,
  authorizationSubject: LandSubject,
  envelope: LandBindingEnvelope,
  binding: BatchAuthorityBinding,
): boolean {
  return (
    decisionInput.subject.kind === "integration_node" &&
    decisionInput.subject.id === binding.nodeId &&
    authorizationSubject.kind === "integration_node" &&
    authorizationSubject.id === binding.nodeId &&
    envelope.subject.kind === "integration_node" &&
    envelope.subject.id === binding.nodeId
  );
}

function exactMembers(
  entries: ReadonlyArray<MergeQueueEntry>,
  binding: BatchAuthorityBinding,
  envelope: LandBindingEnvelope,
): boolean {
  return (
    entries.length === binding.members.length &&
    envelope.members.length === binding.members.length &&
    binding.members.every((member, index) => {
      const entry = entries[index];
      const bound = envelope.members[index];
      return (
        entry?.specId === member.specId &&
        entry.runId === member.runId &&
        bound?.specId === member.specId &&
        bound.runId === member.runId &&
        bound.branch === member.branch &&
        bound.headSha === member.headSha &&
        bound.disposition === "admit"
      );
    })
  );
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
