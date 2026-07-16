// MQ-2 durable evidence helpers. Gate observations stay in the existing
// integration_proofs.evidence JSONB; the quarantine version is a content hash of
// the exact active gate exclusions, not an unrelated policy-version alias.

import { z } from "zod";
import { proofReuseKey, type ProofReuseKeyInput } from "../contracts/integrationNodes.js";
import type { MultiMemberInfrastructureEvidence } from "./multiMemberAuthorityTypes.js";

const ProofKeyInput = z
  .object({
    memberKey: z.string().regex(/^[0-9a-f]{64}$/u),
    gateConfigHash: z.string().min(1),
    policyVersion: z.string().min(1),
    runnerImage: z.string().min(1),
    appEnvHash: z.string().min(1),
    quarantineVersion: z.string().min(1),
  })
  .strict();

/** Canonical evidence persisted with one exact batch gate proof. */
export const BatchGateProofEvidenceV1 = z
  .object({
    kind: z.literal("batch_gate.v1"),
    nodeId: z.string().min(1),
    headSha: z.string().min(1),
    treeHash: z.string().min(1),
    memberSetHash: z.string().regex(/^[0-9a-f]{64}$/u),
    proofReuseKey: z.string().regex(/^[0-9a-f]{64}$/u),
    keyInput: ProofKeyInput,
    verdict: z.enum(["passed", "failed"]),
    message: z.string().min(1).optional(),
  })
  .strict();

export type BatchGateProofEvidenceV1 = z.infer<typeof BatchGateProofEvidenceV1>;

/** Minimum immutable binding needed to validate proof JSONB on engine/read sides. */
export interface BatchGateEvidenceBinding {
  readonly nodeId: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly proof: {
    readonly proofReuseKey: string;
    readonly keyInput: ProofReuseKeyInput;
  };
}

/** Typed production fault the pure evaluator may safely classify as infrastructure. */
export class MultiMemberAuthorityInfrastructureFault extends Error {
  constructor(readonly evidence: MultiMemberInfrastructureEvidence) {
    super(`multi-member authority infrastructure unavailable (${evidence.reasonCode})`);
    this.name = "MultiMemberAuthorityInfrastructureFault";
  }
}

export function buildBatchGateProofEvidence(input: {
  readonly nodeId: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly keyInput: ProofReuseKeyInput;
  readonly passed: boolean;
  readonly message?: string;
}): BatchGateProofEvidenceV1 {
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

/** Reject partial/stale JSONB instead of treating a proof label as evidence. */
export function exactBatchGateProofEvidence(
  raw: unknown,
  binding: BatchGateEvidenceBinding,
  verdict: "passed" | "failed",
): BatchGateProofEvidenceV1 | undefined {
  const parsed = BatchGateProofEvidenceV1.safeParse(raw);
  if (!parsed.success) return undefined;
  const evidence = parsed.data;
  if (
    evidence.verdict !== verdict ||
    evidence.nodeId !== binding.nodeId ||
    evidence.headSha !== binding.headSha ||
    evidence.treeHash !== binding.treeHash ||
    evidence.memberSetHash !== binding.memberSetHash ||
    evidence.proofReuseKey !== binding.proof.proofReuseKey ||
    proofReuseKey(evidence.keyInput) !== evidence.proofReuseKey
  ) {
    return undefined;
  }
  const expected = binding.proof.keyInput;
  return evidence.keyInput.memberKey === expected.memberKey &&
    evidence.keyInput.gateConfigHash === expected.gateConfigHash &&
    evidence.keyInput.policyVersion === expected.policyVersion &&
    evidence.keyInput.runnerImage === expected.runnerImage &&
    evidence.keyInput.appEnvHash === expected.appEnvHash &&
    evidence.keyInput.quarantineVersion === expected.quarantineVersion
    ? evidence
    : undefined;
}
