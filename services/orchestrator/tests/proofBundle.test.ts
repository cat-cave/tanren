// rv-24 — pure build/verify conformance for the exportable proof bundle. No DB: it
// exercises the exact deterministic chain + invariant + embedded-resolution-proof math
// the CLI re-implements standalone and the store feeds real rows into.
import { describe, expect, it } from "vitest";
import { buildResolutionProof, type ResolutionProofEvidence } from "../src/engine/governance/resolutionProof.js";
import {
  buildProofBundle,
  verifyProofBundle,
  type BundleVerdictSection,
  type ProofBundleEvidence,
} from "../src/engine/verification/acceptance/proofBundle.js";

const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

function resolutionEvidence(): ResolutionProofEvidence {
  return {
    orgId: "org_pb",
    projectId: "project_pb",
    issueLoopId: "loop_pb",
    resolutionJobId: "rjob_pb",
    resolutionDecisionId: "rdec_pb",
    sections: {
      issue_loop: {
        issueLoopId: "loop_pb",
        fingerprint: "fp",
        sourceRevision: "r",
        sourceFindingId: "f1",
        providerObjectId: "g1",
      },
      triage: { taskId: "t1", status: "done", agentKind: "triage" },
      spec_origins: [{ id: "so1", specId: "s1", role: "primary", attemptNumber: 1, ordinal: 0 }],
      merge: { mergeSha: "sha", authorityAuditId: "audit1" },
      deployment: { releaseInstanceId: "rel1", artifactDigest: CAS, url: "https://x", state: "live", sourceRef: "sha" },
      baseline: { verificationRunId: "rb", artifactDigest: CAS, classification: "product_failure" },
      counterfactual: { verificationRunId: "rc", artifactDigest: CAS, classification: "product_resolved" },
      production_symptom: {
        verificationRunId: "rp",
        classification: "product_resolved",
        outcome: "passed",
        artifactDigest: CAS,
        preparedHeadSha: "sha",
        probedUrl: "https://x",
        assertions: [{ id: "va1", outcome: "passed" }],
      },
      resolution_decision: {
        decisionId: "rdec_pb",
        decision: "authorized",
        inputSnapshotHash: D,
        authorityVersion: "v1",
      },
      source_sync: { outboxId: "o1", operation: "close", state: "verified", providerReceipt: null, readback: null },
    },
  };
}

function verdict(overrides: Partial<BundleVerdictSection> = {}): BundleVerdictSection {
  return {
    verdictId: "verdict_1",
    behaviorRevisionId: "br_1",
    outcome: "passed",
    requiredAssertionCount: 12,
    executedAssertionCount: 12,
    attemptCount: 1,
    flakeState: "stable",
    gateEffect: "blocking",
    exampleHash: D,
    matrixHash: D,
    artifactDigest: CAS,
    proofUnitDigest: null,
    runtimeBehaviorContextHash: D,
    ...overrides,
  };
}

function evidence(overrides: Partial<ProofBundleEvidence> = {}): ProofBundleEvidence {
  return {
    orgId: "org_pb",
    projectId: "project_pb",
    runId: "run_pb",
    run: {
      runId: "run_pb",
      projectId: "project_pb",
      purpose: "post_merge_production",
      status: "completed",
      stage: "production",
      classification: "product_resolved",
      resolutionJobId: "rjob_pb",
      specId: "s1",
      integrationNodeId: "inode_1",
      preparedHeadSha: "sha",
      jjTreeId: D,
      planSetHash: D,
      runtimeBehaviorContextHash: D,
      artifactDigest: CAS,
    },
    environment: {
      environmentId: "venv_1",
      projectId: "project_pb",
      integrationNodeId: "inode_1",
      artifactDigest: CAS,
      deploymentTarget: "container",
      environmentFingerprint: D,
      tenantLeaseId: "lease_1",
      lifecycleStatus: "ready",
    },
    verdicts: [verdict()],
    resolutionProofs: [buildResolutionProof(resolutionEvidence(), "authorized_verified_closed")],
    ...overrides,
  };
}

describe("rv-24 proof bundle — build + offline verify", () => {
  it("a genuine unmodified bundle verifies valid and recomputes the same root", () => {
    const bundle = buildProofBundle(evidence());
    const result = verifyProofBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.divergedAt).toBeNull();
    expect(result.recomputedBundleHash).toBe(bundle.bundleHash);
    expect(result.resolutionProofs).toEqual([{ index: 0, issueLoopId: "loop_pb", valid: true, divergedAt: null }]);
  });

  it("DECISIVE: editing any verdict field (not re-chaining) makes verify INVALID at the diverging section", () => {
    const bundle = buildProofBundle(evidence());
    const tampered = structuredClone(bundle) as typeof bundle;
    // Launder a passed verdict — but the stored chain still pins the original bytes.
    (tampered.evidence.verdicts as BundleVerdictSection[])[0] = verdict({
      outcome: "passed",
      executedAssertionCount: 12,
    });
    (tampered.evidence.verdicts as { outcome: string }[])[0].outcome = "failed_product";
    const result = verifyProofBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.divergedAt).toBe("verdicts");
  });

  it("DECISIVE: recompute does not trust the stored bundleHash — a swapped top hash is caught", () => {
    const bundle = buildProofBundle(evidence());
    const tampered = { ...bundle, bundleHash: `sha256:${"f".repeat(64)}` };
    const result = verifyProofBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.recomputedBundleHash).toBe(bundle.bundleHash);
  });

  it("editing the environment binding is caught at the environment section", () => {
    const bundle = buildProofBundle(evidence());
    const tampered = structuredClone(bundle) as typeof bundle;
    (tampered.evidence.environment as { artifactDigest: string }).artifactDigest = `sha256:${"b".repeat(64)}`;
    expect(verifyProofBundle(tampered).divergedAt).toBe("environment");
  });

  it("a FAILED verdict is exported as failed — the bundle cannot launder it to passed", () => {
    const bundle = buildProofBundle(
      evidence({
        verdicts: [verdict({ outcome: "failed_product", executedAssertionCount: 0, requiredAssertionCount: 12 })],
      }),
    );
    expect(bundle.evidence.verdicts[0]?.outcome).toBe("failed_product");
    // Failed verdict has no coverage floor to meet, so the bundle is internally valid.
    expect(verifyProofBundle(bundle).valid).toBe(true);
  });

  it("DECISIVE: a re-chained bundle claiming passed with executed < required is INVALID via the invariant recheck", () => {
    // A sophisticated tamper rebuilds the chain so hashes are internally consistent...
    const bad = buildProofBundle(
      evidence({ verdicts: [verdict({ outcome: "passed", requiredAssertionCount: 12, executedAssertionCount: 1 })] }),
    );
    const result = verifyProofBundle(bad);
    // ...but the chain is consistent (divergedAt null) while the domain invariant fails.
    expect(result.divergedAt).toBeNull();
    expect(result.valid).toBe(false);
    expect(result.invariantViolations[0]).toMatch(/executed_assertion_count 1 < required 12/u);
  });

  it("passed with a zero coverage floor (required < 1) is INVALID", () => {
    const bad = buildProofBundle(
      evidence({ verdicts: [verdict({ outcome: "passed", requiredAssertionCount: 0, executedAssertionCount: 0 })] }),
    );
    const result = verifyProofBundle(bad);
    expect(result.valid).toBe(false);
    expect(result.invariantViolations[0]).toMatch(/required_assertion_count < 1/u);
  });

  it("tampering an embedded resolution proof's evidence surfaces as an invalid sub-proof", () => {
    const bundle = buildProofBundle(evidence());
    const tampered = structuredClone(bundle) as typeof bundle;
    // Rebuild the bundle chain over the mutated resolution proof so the bundle-level
    // chain stays consistent, isolating the sub-proof self-verification path.
    (
      tampered.evidence.resolutionProofs[0] as { evidence: { sections: { merge: { mergeSha: string } } } }
    ).evidence.sections.merge.mergeSha = "forged";
    const rebuilt = buildProofBundle(tampered.evidence);
    const result = verifyProofBundle(rebuilt);
    expect(result.valid).toBe(false);
    expect(result.resolutionProofs[0]?.valid).toBe(false);
    expect(result.resolutionProofs[0]?.divergedAt).toBe("merge");
  });
});
