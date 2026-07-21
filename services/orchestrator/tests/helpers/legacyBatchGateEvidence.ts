import { proofReuseKey, type ProofReuseKeyInput } from "../../src/engine/contracts/integrationNodes.js";
import { BatchGateProofEvidenceV1 } from "../../src/engine/merge/multiMemberAuthorityEvidence.js";

/** Test-only fixture builder for pre-RV-14 rows displayed by the historical read route. */
export function buildBatchGateProofEvidence(input: {
  readonly nodeId: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly keyInput: ProofReuseKeyInput;
  readonly passed: boolean;
  readonly message?: string;
}) {
  return BatchGateProofEvidenceV1.parse({
    kind: "batch_gate.v1",
    nodeId: input.nodeId,
    headSha: input.headSha,
    treeHash: input.treeHash,
    memberSetHash: input.memberSetHash,
    proofReuseKey: proofReuseKey(input.keyInput),
    keyInput: input.keyInput,
    verdict: input.passed ? "passed" : "failed",
    ...(input.message === undefined ? {} : { message: input.message }),
  });
}
