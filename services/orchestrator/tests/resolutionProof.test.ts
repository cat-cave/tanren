// cspell:ignore sfind sorigin vassert iloop
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildResolutionProof,
  canonicalJson,
  deriveProofBadges,
  PROOF_ENTRY_KINDS,
  verifyResolutionProof,
  type ResolutionProofEvidence,
} from "../src/engine/governance/resolutionProof.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

/** A green forward half: merged, deployed, reachable, symptom passed. */
function resolvedEvidence(): ResolutionProofEvidence {
  return {
    orgId: "org_proof",
    projectId: "project_proof",
    issueLoopId: "iloop_proof",
    resolutionJobId: "rjob_proof_production",
    resolutionDecisionId: "rdec_" + "a".repeat(64),
    sections: {
      issue_loop: {
        issueLoopId: "iloop_proof",
        fingerprint: "fp-proof",
        sourceRevision: "rev-1",
        sourceFindingId: "sfind_proof",
        providerObjectId: "issue-1",
      },
      triage: { taskId: "task_proof_triage", status: "done", agentKind: "answerer" },
      spec_origins: [{ id: "sorigin_proof", specId: "spec_proof", role: "primary_fix", attemptNumber: 1, ordinal: 0 }],
      merge: { mergeSha: "a".repeat(40), authorityAuditId: "audit_proof" },
      deployment: {
        releaseInstanceId: "release_proof",
        artifactDigest: digest("artifact"),
        url: "https://proof.example/app",
        state: "live",
        sourceRef: "a".repeat(40),
      },
      baseline: {
        verificationRunId: "vrun_baseline",
        artifactDigest: digest("artifact"),
        classification: "product_failure",
      },
      counterfactual: {
        verificationRunId: "vrun_counterfactual",
        artifactDigest: digest("artifact"),
        classification: "product_resolved",
      },
      production_symptom: {
        verificationRunId: "vrun_production",
        classification: "product_resolved",
        outcome: "passed",
        artifactDigest: digest("artifact"),
        preparedHeadSha: "a".repeat(40),
        probedUrl: "https://proof.example/app",
        assertions: [{ id: "vassert_1", outcome: "passed" }],
      },
      resolution_decision: {
        decisionId: "rdec_" + "a".repeat(64),
        decision: "authorized",
        inputSnapshotHash: digest("snapshot"),
        authorityVersion: "tanren-resolution-authority.v1",
      },
      source_sync: {
        outboxId: "sso_proof",
        operation: "close",
        state: "verified",
        providerReceipt: { providerRevision: "rev-2" },
        readback: { desiredState: "closed", providerRevision: "rev-2" },
      },
    },
  };
}

/** A cosmetic fix: merged/deployed/reachable stay green, but the symptom failed. */
function cosmeticBlockedEvidence(): ResolutionProofEvidence {
  const base = resolvedEvidence();
  return {
    ...base,
    resolutionJobId: "rjob_proof_cosmetic",
    resolutionDecisionId: "rdec_" + "b".repeat(64),
    sections: {
      ...base.sections,
      counterfactual: null,
      production_symptom: {
        verificationRunId: "vrun_cosmetic",
        classification: "product_failure",
        outcome: "failed",
        artifactDigest: digest("artifact"),
        preparedHeadSha: "a".repeat(40),
        probedUrl: "https://proof.example/app",
        assertions: [{ id: "vassert_cosmetic", outcome: "failed" }],
      },
      resolution_decision: {
        decisionId: "rdec_" + "b".repeat(64),
        decision: "blocked",
        inputSnapshotHash: digest("snapshot-cosmetic"),
        authorityVersion: "tanren-resolution-authority.v1",
      },
      source_sync: null,
    },
  };
}

describe("resolution proof — pure hash-chain composition", () => {
  it("chains every entry over the prior hash and the section's evidence bytes", () => {
    const evidence = resolvedEvidence();
    const proof = buildResolutionProof(evidence, "authorized_verified_closed");
    expect(proof.entries.map((entry) => entry.kind)).toEqual([...PROOF_ENTRY_KINDS]);

    let priorHex = sha256Hex("tanren-resolution-proof.v1:genesis");
    for (const [index, kind] of PROOF_ENTRY_KINDS.entries()) {
      const evidenceHex = sha256Hex(canonicalJson(evidence.sections[kind]));
      const chainHex = sha256Hex(`${priorHex}|${evidenceHex}`);
      expect(proof.entries[index]?.evidenceHash).toBe(`sha256:${evidenceHex}`);
      expect(proof.entries[index]?.hash).toBe(`sha256:${chainHex}`);
      priorHex = chainHex;
    }
    expect(proof.proofHash).toBe(proof.entries.at(-1)?.hash);
  });

  it("verifies a proof against unmodified evidence", () => {
    const evidence = resolvedEvidence();
    const proof = buildResolutionProof(evidence, "authorized_verified_closed");
    expect(verifyResolutionProof(evidence, proof)).toEqual({
      valid: true,
      divergedAt: null,
      recomputedProofHash: proof.proofHash,
    });
  });

  it("reports invalid, at the tampered entry, when ANY linked section is edited", () => {
    const evidence = resolvedEvidence();
    const proof = buildResolutionProof(evidence, "authorized_verified_closed");
    // Edit the probed production URL — a single linked evidence field.
    const tampered: ResolutionProofEvidence = {
      ...evidence,
      sections: {
        ...evidence.sections,
        deployment: { ...evidence.sections.deployment!, url: "https://attacker.example/app" },
      },
    };
    const verification = verifyResolutionProof(tampered, proof);
    expect(verification.valid).toBe(false);
    expect(verification.divergedAt).toBe("deployment");
    expect(verification.recomputedProofHash).not.toBe(proof.proofHash);
  });

  it("detects tampering of the terminal source-sync receipt too", () => {
    const evidence = resolvedEvidence();
    const proof = buildResolutionProof(evidence, "authorized_verified_closed");
    const tampered: ResolutionProofEvidence = {
      ...evidence,
      sections: { ...evidence.sections, source_sync: { ...evidence.sections.source_sync!, state: "pending" } },
    };
    const verification = verifyResolutionProof(tampered, proof);
    expect(verification.valid).toBe(false);
    expect(verification.divergedAt).toBe("source_sync");
  });

  it("keeps the truth badges separate — a blocked cosmetic fix stays green except symptom", () => {
    const badges = deriveProofBadges(cosmeticBlockedEvidence());
    expect(badges).toEqual({
      gate: "passed",
      merged: "passed",
      deploy: "bound",
      demo: "reachable",
      symptom: "failed",
      source: "absent",
    });
  });

  it("shows the full green ladder for a resolved+verified_closed loop", () => {
    const badges = deriveProofBadges(resolvedEvidence());
    expect(badges).toEqual({
      gate: "passed",
      merged: "passed",
      deploy: "bound",
      demo: "reachable",
      symptom: "passed",
      source: "verified_closed",
    });
  });
});
