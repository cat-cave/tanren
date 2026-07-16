// cspell:ignore mqeval mqgrp mqwake
import { createHash } from "node:crypto";
import type { AuthorizeLandInput, LandBindingEnvelope } from "../contracts/mergeAuthority.js";

export type AuthorityIdentityValue =
  | null
  | boolean
  | number
  | string
  | readonly AuthorityIdentityValue[]
  | AuthorityIdentityObject;

export interface AuthorityIdentityObject {
  readonly [key: string]: AuthorityIdentityValue;
}

function canonicalJson(value: AuthorityIdentityValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("merge-signal identity cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as AuthorityIdentityObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

export function authorityDerivedId(prefix: "mqeval" | "mqgrp" | "mqwake", value: AuthorityIdentityValue): string {
  return `${prefix}_${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bindingFingerprint(envelope: LandBindingEnvelope): AuthorityIdentityObject {
  return {
    artifactDigest: envelope.artifactDigest,
    expectedMainSha: envelope.expectedMainSha,
    headSha: envelope.headSha,
    memberSetHash: envelope.memberSetHash,
    members: envelope.members.map((member) => ({
      branch: member.branch,
      disposition: member.disposition,
      headSha: member.headSha,
      runId: member.runId,
      specId: member.specId,
    })),
    policyVersion: envelope.policyVersion,
    proofRoot: envelope.proofRoot,
    subject: { id: envelope.subject.id, kind: envelope.subject.kind },
    target: {
      intoMain: envelope.target.intoMain,
      repo: { name: envelope.target.repo.name, owner: envelope.target.repo.owner },
    },
  };
}

function decisionFingerprint(input: AuthorizeLandInput): AuthorityIdentityObject {
  return {
    auditPosture: {
      autonomousRemediation: input.auditPosture.autonomousRemediation ?? false,
      blockReviewAt: input.auditPosture.blockReviewAt,
      p2p3Handling: input.auditPosture.p2p3Handling,
    },
    budget:
      input.budget.kind === "resolved"
        ? { ceilingUsd: input.budget.ceilingUsd, kind: input.budget.kind, spentUsd: input.budget.spentUsd }
        : input.budget.kind === "unresolvable"
          ? { kind: input.budget.kind, reason: input.budget.reason }
          : { kind: input.budget.kind },
    conflicts: input.conflicts,
    demo: input.demo,
    findings: [...input.findings]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((finding) => ({
        body: finding.body,
        fixHint: finding.fixHint ?? null,
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
      })),
    gateVerdict: input.gateVerdict,
    hitlSignoff: input.hitlSignoff,
    mergeability: input.mergeability,
    reviewVerdict: input.reviewVerdict,
    subject: { id: input.subject.id, kind: input.subject.kind },
  };
}

/** Stable MQ identity shared by W0 signal facts and MQ-2 seven-way evaluations. */
export function authoritySignalIdentity(input: {
  decisionInput: AuthorizeLandInput;
  envelope: LandBindingEnvelope;
  evidence: AuthorityIdentityValue;
  signalVersion: string;
}): { evaluationId: string; groupId: string } {
  const groupId = authorityDerivedId("mqgrp", {
    memberSetHash: input.envelope.memberSetHash,
    members: input.envelope.members.map((member) => ({ runId: member.runId, specId: member.specId })),
    subject: { id: input.envelope.subject.id, kind: input.envelope.subject.kind },
  });
  const evaluationId = authorityDerivedId("mqeval", {
    binding: bindingFingerprint(input.envelope),
    decision: decisionFingerprint(input.decisionInput),
    evidence: input.evidence,
    signalVersion: input.signalVersion,
  });
  return { evaluationId, groupId };
}
