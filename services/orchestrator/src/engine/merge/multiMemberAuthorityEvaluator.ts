// MQ-2 exact multi-member evaluation. The only authority operation reachable here is
// SP-4 `authorizeLand`; host land remains exclusively in the existing per-member path.

import { decideFromFindings } from "../contracts/auditPosture.js";
import { severityRank, type Finding } from "../contracts/findings.js";
import { memberKey, proofReuseKey } from "../contracts/integrationNodes.js";
import type { LandAuthorization, LandBindingMember } from "../contracts/mergeAuthority.js";
import {
  classifyMergeSignal,
  mergeAuthorityEvidence,
  mergeInfrastructureEvidence,
  type MergeSignalClassificationV1,
} from "./authoritySignalClassification.js";
import { authoritySignalIdentity, type AuthorityIdentityValue } from "./authoritySignalIdentity.js";
import { MultiMemberAuthorityInfrastructureFault } from "./multiMemberAuthorityEvidence.js";
import {
  batchArtifactDigest,
  batchProofRoot,
  MULTI_MEMBER_AUTHORITY_VERSION,
  type EvaluateMultiMemberAuthorityInput,
  type MultiMemberAuthorityEvaluation,
  type MultiMemberAuthorityMemberOutcome,
  type SameTreeFlakeEvidence,
} from "./multiMemberAuthorityTypes.js";

type W0Unknown = Extract<MergeSignalClassificationV1, { classification: "unknown_fail_closed" }>;

function stableUnique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

function reasonInputs(authorization: LandAuthorization): string[] {
  return stableUnique(authorization.reasons.map((reason) => reason.input));
}

function identities(input: EvaluateMultiMemberAuthorityInput, evidence: AuthorityIdentityValue) {
  return authoritySignalIdentity({
    decisionInput: input.decisionInput,
    envelope: input.envelope,
    evidence,
    signalVersion: MULTI_MEMBER_AUTHORITY_VERSION,
  });
}

function membersHeld(
  input: EvaluateMultiMemberAuthorityInput,
  reasonCode: string,
): MultiMemberAuthorityMemberOutcome[] {
  return input.binding.members.map((member) => ({
    ...member,
    disposition: "hold",
    findingIds: [],
    reasonCodes: [reasonCode],
  }));
}

function common(
  input: EvaluateMultiMemberAuthorityInput,
  ids: { evaluationId: string; groupId: string },
  members: ReadonlyArray<MultiMemberAuthorityMemberOutcome>,
  reasonCodes: ReadonlyArray<string>,
) {
  return {
    ...ids,
    version: MULTI_MEMBER_AUTHORITY_VERSION,
    nodeId: input.binding.nodeId,
    memberSetHash: input.binding.memberSetHash,
    proofReuseKey: input.binding.proof.proofReuseKey,
    members,
    reasonCodes: stableUnique(reasonCodes),
  } as const;
}

function unknownClassification(input: EvaluateMultiMemberAuthorityInput): W0Unknown | undefined {
  const classification = classifyMergeSignal({
    decisionInput: input.decisionInput,
    envelope: input.envelope,
    evidence: null,
  });
  return classification.classification === "unknown_fail_closed" ? classification : undefined;
}

function unknownResult(
  input: EvaluateMultiMemberAuthorityInput,
  reasonCodes: ReadonlyArray<string>,
  authorization?: LandAuthorization,
  classification: W0Unknown | undefined = unknownClassification(input),
): MultiMemberAuthorityEvaluation {
  const ids =
    classification === undefined
      ? identities(input, { kind: "unknown_fail_closed", reasonCodes: stableUnique(reasonCodes) })
      : { evaluationId: classification.evaluationId, groupId: classification.groupId };
  return {
    ...common(input, ids, membersHeld(input, "unknown_fail_closed"), reasonCodes),
    kind: "unknown_fail_closed",
    eligibleMemberIds: [],
    ...(authorization !== undefined && { authorization }),
    ...(classification !== undefined && { w0: classification }),
  };
}

/**
 * Evaluate one exact persisted multi-member node. Validation runs before the authority;
 * a malformed/stale proof binding cannot be laundered into an authorized result by a
 * permissive test double. Typed infra/flake evidence short-circuits without blame.
 */
export async function evaluateMultiMemberAuthority(
  input: EvaluateMultiMemberAuthorityInput,
): Promise<MultiMemberAuthorityEvaluation> {
  const bindingErrors = validateExactBinding(input);
  if (bindingErrors.length > 0) return unknownResult(input, bindingErrors);

  if (input.evidence?.kind === "infrastructure") {
    return infrastructureResult(input, input.evidence);
  }

  if (input.evidence?.kind === "same_tree_flake") {
    return flakeResult(input, input.evidence);
  }

  let authorization: LandAuthorization;
  try {
    authorization = await input.authority.authorizeLand(input.decisionInput, input.envelope);
  } catch (error) {
    if (error instanceof MultiMemberAuthorityInfrastructureFault) {
      return infrastructureResult(input, error.evidence);
    }
    return unknownResult(input, ["authority_evaluation_threw"]);
  }

  const classification = classifyMergeSignal({
    decisionInput: input.decisionInput,
    envelope: input.envelope,
    evidence: mergeAuthorityEvidence(authorization),
    attributedMemberIds: attributedBlockingMembers(input),
  });

  if (authorization.decision === "authorized") {
    if (classification.classification !== "unknown_fail_closed") {
      return unknownResult(input, ["authorized_with_blocking_classification"], authorization);
    }
    const ids = identities(input, { decision: "authorized", kind: "authority", reasonInputs: [] });
    const members = input.binding.members.map((member) => ({
      ...member,
      disposition: "admit" as const,
      findingIds: [],
      reasonCodes: [],
    }));
    return {
      ...common(input, ids, members, []),
      kind: "authorized_subset",
      authorizedMemberIds: members.map((member) => member.specId),
      eligibleMemberIds: members.map((member) => member.specId),
      authorization,
    };
  }

  if (authorization.decision === "needs_attention") {
    if (classification.classification !== "needs_product_decision") {
      return unknownResult(input, ["contradictory_product_and_policy_evidence"], authorization);
    }
    return {
      ...common(
        input,
        { evaluationId: classification.evaluationId, groupId: classification.groupId },
        membersHeld(input, "needs_product_decision"),
        [classification.reasonCode, ...reasonInputs(authorization)],
      ),
      kind: "needs_product_decision",
      eligibleMemberIds: [],
      authorization,
      w0: classification,
    };
  }

  const attribution = validateBlockingAttribution(input);
  if (attribution.kind === "attributed") {
    if (classification.classification !== "deterministic_policy") {
      return unknownResult(input, ["blocking_findings_not_classified_as_member_policy"], authorization);
    }
    return memberFailureResult(input, authorization, classification, attribution.byMember);
  }
  if (attribution.kind === "invalid") {
    const w0 = classification.classification === "unknown_fail_closed" ? classification : undefined;
    return unknownResult(input, attribution.reasons, authorization, w0);
  }

  if (isDeterministicInteraction(input, authorization)) {
    const ids = identities(input, {
      decision: authorization.decision,
      kind: "interaction_failure",
      reasonInputs: reasonInputs(authorization),
    });
    return {
      ...common(input, ids, membersHeld(input, "interaction_failure"), [
        "integrated_residual_block",
        ...reasonInputs(authorization),
      ]),
      kind: "interaction_failure",
      eligibleMemberIds: [],
      authorization,
    };
  }

  const w0 = classification.classification === "unknown_fail_closed" ? classification : undefined;
  return unknownResult(input, ["authority_blocked_fail_closed", ...reasonInputs(authorization)], authorization, w0);
}

function infrastructureResult(
  input: EvaluateMultiMemberAuthorityInput,
  evidence: Extract<NonNullable<EvaluateMultiMemberAuthorityInput["evidence"]>, { kind: "infrastructure" }>,
): MultiMemberAuthorityEvaluation {
  const classification = classifyMergeSignal({
    decisionInput: input.decisionInput,
    envelope: input.envelope,
    evidence: mergeInfrastructureEvidence(evidence),
  });
  if (classification.classification !== "transient_infrastructure") {
    return unknownResult(input, ["invalid_infrastructure_evidence"]);
  }
  return {
    ...common(
      input,
      { evaluationId: classification.evaluationId, groupId: classification.groupId },
      membersHeld(input, "transient_infrastructure"),
      [classification.reasonCode],
    ),
    kind: "transient_infrastructure",
    eligibleMemberIds: [],
    w0: classification,
  };
}

function flakeResult(
  input: EvaluateMultiMemberAuthorityInput,
  evidence: SameTreeFlakeEvidence,
): MultiMemberAuthorityEvaluation {
  const [first, second] = evidence.observations;
  const valid =
    evidence.treeHash === input.binding.treeHash &&
    evidence.quarantineVersion === input.binding.proof.keyInput.quarantineVersion &&
    first.id.trim() !== "" &&
    second.id.trim() !== "" &&
    first.id !== second.id &&
    first.verdict !== second.verdict;
  if (!valid) return unknownResult(input, ["incomplete_same_tree_flake_evidence"]);
  const ids = identities(input, {
    kind: "flake_observation",
    observationIds: [first.id, second.id],
    quarantineVersion: evidence.quarantineVersion,
    treeHash: evidence.treeHash,
    verdicts: [first.verdict, second.verdict],
  });
  return {
    ...common(input, ids, membersHeld(input, "flake_observation"), ["same_tree_nondeterminism"]),
    kind: "flake_observation",
    eligibleMemberIds: [],
    treeHash: evidence.treeHash,
    quarantineVersion: evidence.quarantineVersion,
    observationIds: [first.id, second.id],
  };
}

function memberFailureResult(
  input: EvaluateMultiMemberAuthorityInput,
  authorization: LandAuthorization,
  classification: Extract<MergeSignalClassificationV1, { classification: "deterministic_policy" }>,
  findingIdsByMember: ReadonlyMap<string, ReadonlyArray<string>>,
): MultiMemberAuthorityEvaluation {
  const failed = new Set(findingIdsByMember.keys());
  const held = new Set<string>();
  for (const entry of input.entries) {
    if (failed.has(entry.specId)) continue;
    if (entry.dependsOn.some((dependency) => failed.has(dependency) || held.has(dependency))) held.add(entry.specId);
  }
  const members = input.binding.members.map((member) => {
    const findingIds = findingIdsByMember.get(member.specId) ?? [];
    if (failed.has(member.specId)) {
      return { ...member, disposition: "exclude" as const, findingIds, reasonCodes: ["audit_policy"] };
    }
    if (held.has(member.specId)) {
      return { ...member, disposition: "hold" as const, findingIds: [], reasonCodes: ["dependency_failed"] };
    }
    return { ...member, disposition: "admit" as const, findingIds: [], reasonCodes: [] };
  });
  const eligibleMemberIds = members.filter((member) => member.disposition === "admit").map((member) => member.specId);
  return {
    ...common(input, { evaluationId: classification.evaluationId, groupId: classification.groupId }, members, [
      classification.reasonCode,
      ...reasonInputs(authorization),
    ]),
    kind: "member_failure",
    failedMemberIds: stableUnique([...failed]),
    heldMemberIds: stableUnique([...held]),
    eligibleMemberIds,
    findingIds: stableUnique([...findingIdsByMember.values()].flat()),
    authorization,
    w0: classification,
  };
}

type AttributionValidation =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reasons: ReadonlyArray<string> }
  | { readonly kind: "attributed"; readonly byMember: ReadonlyMap<string, ReadonlyArray<string>> };

function validateBlockingAttribution(input: EvaluateMultiMemberAuthorityInput): AttributionValidation {
  const blocking = blockingFindings(input);
  if (blocking.length === 0) return { kind: "none" };
  const memberByKey = new Map(input.binding.members.map((member) => [`${member.specId}\0${member.runId}`, member]));
  const decisionFindingById = new Map(input.decisionInput.findings.map((finding) => [finding.id, finding]));
  if (decisionFindingById.size !== input.decisionInput.findings.length) {
    return { kind: "invalid", reasons: ["duplicate_decision_finding_id"] };
  }
  const ownerByFinding = new Map<string, string>();
  const byMember = new Map<string, string[]>();
  const errors: string[] = [];
  for (const attribution of input.memberFindings) {
    const key = `${attribution.specId}\0${attribution.runId}`;
    if (!memberByKey.has(key)) {
      errors.push("attribution_member_not_bound");
      continue;
    }
    for (const finding of attribution.findings) {
      const decisionFinding = decisionFindingById.get(finding.id);
      if (decisionFinding === undefined || !sameFinding(decisionFinding, finding)) {
        errors.push("attribution_finding_not_in_decision");
        continue;
      }
      const prior = ownerByFinding.get(finding.id);
      if (prior !== undefined && prior !== attribution.specId) {
        errors.push("finding_attributed_to_multiple_members");
        continue;
      }
      ownerByFinding.set(finding.id, attribution.specId);
      const ids = byMember.get(attribution.specId) ?? [];
      ids.push(finding.id);
      byMember.set(attribution.specId, ids);
    }
  }
  for (const finding of blocking) {
    if (!ownerByFinding.has(finding.id)) errors.push("blocking_finding_unattributed");
  }
  if (errors.length > 0) return { kind: "invalid", reasons: stableUnique(errors) };
  const blockingIds = new Set(blocking.map((finding) => finding.id));
  const blockingByMember = new Map<string, ReadonlyArray<string>>();
  for (const [specId, ids] of byMember) {
    const selected = stableUnique(ids.filter((id) => blockingIds.has(id)));
    if (selected.length > 0) blockingByMember.set(specId, selected);
  }
  return blockingByMember.size === 0
    ? { kind: "invalid", reasons: ["blocking_finding_unattributed"] }
    : { kind: "attributed", byMember: blockingByMember };
}

function attributedBlockingMembers(input: EvaluateMultiMemberAuthorityInput): ReadonlyArray<string> | undefined {
  const attribution = validateBlockingAttribution(input);
  return attribution.kind === "attributed" ? [...attribution.byMember.keys()] : undefined;
}

function blockingFindings(input: EvaluateMultiMemberAuthorityInput): Finding[] {
  if (!decideFromFindings(input.decisionInput.findings, input.decisionInput.auditPosture).block) return [];
  return input.decisionInput.findings.filter(
    (finding) => severityRank(finding.severity) <= severityRank(input.decisionInput.auditPosture.blockReviewAt),
  );
}

function sameFinding(left: Finding, right: Finding): boolean {
  return (
    left.id === right.id &&
    left.severity === right.severity &&
    left.title === right.title &&
    left.body === right.body &&
    left.fixHint === right.fixHint
  );
}

function isDeterministicInteraction(
  input: EvaluateMultiMemberAuthorityInput,
  authorization: LandAuthorization,
): boolean {
  const inputs = new Set(reasonInputs(authorization));
  if (inputs.size === 0) return false;
  if (inputs.has("binding") || inputs.has("budget") || inputs.has("demo") || inputs.has("findings")) return false;
  if (inputs.has("reviewVerdict") || inputs.has("hitlSignoff") || inputs.has("mergeability")) return false;
  if (inputs.has("gateVerdict") && input.decisionInput.gateVerdict !== "failed") return false;
  if (inputs.has("conflicts") && input.decisionInput.conflicts !== "unresolved") return false;
  return [...inputs].every((value) => value === "gateVerdict" || value === "conflicts");
}

function validateExactBinding(input: EvaluateMultiMemberAuthorityInput): string[] {
  const { binding, decisionInput, envelope, entries } = input;
  const errors: string[] = [];
  if (binding.nodeId.trim() === "" || binding.members.length < 2) errors.push("invalid_multi_member_node");
  if (binding.headSha.trim() === "" || binding.treeHash.trim() === "") errors.push("missing_materialized_head");
  if (
    binding.memberSetHash !==
    memberKey(
      binding.baseSha,
      binding.members.map((member) => member.headSha),
    )
  ) {
    errors.push("member_set_hash_mismatch");
  }
  if (
    binding.proof.verdict !== "passed" ||
    binding.proof.keyInput.memberKey !== binding.memberSetHash ||
    binding.proof.keyInput.policyVersion !== binding.policyVersion ||
    proofReuseKey(binding.proof.keyInput) !== binding.proof.proofReuseKey
  ) {
    errors.push("passing_proof_binding_mismatch");
  }
  if (decisionInput.subject.id !== binding.nodeId || envelope.subject.id !== binding.nodeId) {
    errors.push("integration_node_subject_mismatch");
  }
  if (
    envelope.headSha !== binding.headSha ||
    envelope.expectedMainSha !== binding.baseSha ||
    envelope.memberSetHash !== binding.memberSetHash ||
    envelope.policyVersion !== binding.policyVersion
  ) {
    errors.push("land_envelope_identity_mismatch");
  }
  try {
    if (envelope.artifactDigest !== batchArtifactDigest(binding)) errors.push("artifact_digest_mismatch");
    if (envelope.proofRoot !== batchProofRoot(binding)) errors.push("proof_root_mismatch");
  } catch {
    errors.push("invalid_digest_binding");
  }
  if (!sameEnvelopeMembers(envelope.members, binding.members)) errors.push("ordered_member_binding_mismatch");
  if (entries.length === binding.members.length) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const member = binding.members[index];
      if (entry?.specId !== member?.specId || entry?.runId !== member?.runId)
        errors.push("queue_member_order_mismatch");
    }
  } else {
    errors.push("queue_member_count_mismatch");
  }
  const memberKeys = binding.members.map((member) => `${member.specId}\0${member.runId}`);
  if (new Set(memberKeys).size !== memberKeys.length) errors.push("duplicate_bound_member");
  return stableUnique(errors);
}

function sameEnvelopeMembers(
  envelopeMembers: ReadonlyArray<LandBindingMember>,
  bindingMembers: EvaluateMultiMemberAuthorityInput["binding"]["members"],
): boolean {
  if (envelopeMembers.length !== bindingMembers.length) return false;
  return envelopeMembers.every((member, index) => {
    const bound = bindingMembers[index];
    return (
      bound !== undefined &&
      member.specId === bound.specId &&
      member.runId === bound.runId &&
      member.branch === bound.branch &&
      member.headSha === bound.headSha &&
      member.disposition === "admit"
    );
  });
}
