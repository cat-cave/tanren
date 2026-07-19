// rv-24 — the exportable proof bundle. A `tanren-proof-bundle.v1` document packages
// the REAL persisted acceptance evidence for one behavior-verification run — the run
// row, the deploy-created verification-environment binding, the append-only
// `behavior_verdicts` ledger, and (where the run belongs to an issue-loop resolution)
// the bh-14a sealed resolution proofs — behind a tamper-evident sha256 hash-chain, so
// the whole bundle is INDEPENDENTLY VERIFIABLE OFFLINE, with no live DB.
//
// This module owns ONLY the pure, deterministic build + verify (the same math the
// `tanren proof verify` CLI re-implements standalone). The org-scoped DB reads that
// assemble the evidence live in `proofBundleStore.ts`. The chain mirrors
// `resolutionProof.ts`: each ordered entry hashes `(prior_hash ‖ this_evidence)`
// (sha256), so editing any single evidence field re-derives a different entry hash and
// breaks every entry after it. `verifyProofBundle` RECOMPUTES the chain from the
// bundle's own evidence — it never trusts a stored verdict — and additionally re-checks
// the 0079 domain invariant (a `passed` verdict is impossible unless
// executed >= required >= 1) and re-verifies every embedded resolution proof against its
// own pinned evidence.

import { createHash } from "node:crypto";
import { canonicalJson, verifyResolutionProof, type SealedResolutionProof } from "../../governance/resolutionProof.js";

export const PROOF_BUNDLE_VERSION = "tanren-proof-bundle.v1";

/** Domain-separated chain root so a bundle hash can never collide with a section hash. */
const BUNDLE_CHAIN_GENESIS = `${PROOF_BUNDLE_VERSION}:genesis`;

/**
 * The chain's fixed entry order. Every bundle chains all four sections in this order
 * regardless of which evidence is present; an absent section chains its canonical
 * `null`/`[]`, so a missing environment binding is itself tamper-evident.
 */
export const BUNDLE_ENTRY_KINDS = ["run", "environment", "verdicts", "resolution_proofs"] as const;
export type BundleEntryKind = (typeof BUNDLE_ENTRY_KINDS)[number];

/** One acceptance run — the immutable spine of the bundle. */
export type BundleRunSection = {
  readonly runId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly status: string;
  readonly stage: string | null;
  readonly classification: string | null;
  readonly resolutionJobId: string | null;
  readonly specId: string | null;
  readonly integrationNodeId: string | null;
  readonly preparedHeadSha: string;
  readonly jjTreeId: string;
  readonly planSetHash: string;
  readonly runtimeBehaviorContextHash: string;
  readonly artifactDigest: string;
};

/** The deploy-created verification-environment binding the run executed against. */
export type BundleEnvironmentSection = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly integrationNodeId: string;
  readonly artifactDigest: string;
  readonly deploymentTarget: string;
  readonly environmentFingerprint: string;
  readonly tenantLeaseId: string;
  readonly lifecycleStatus: string;
};

/** One FK-bound assertion row backing a verdict's required/executed counts. */
export type BundleVerdictAssertionEvidence = {
  readonly assertionId: string;
  readonly executed: boolean;
  readonly passed: boolean | null;
};

/** One FK-bound execution-attempt row backing a verdict's retry count. */
export type BundleVerdictAttemptEvidence = {
  readonly attemptOrdinal: number;
  readonly outcome: string;
};

/** One immutable per-behavior verdict from the hardened acceptance ledger. */
export type BundleVerdictSection = {
  readonly verdictId: string;
  readonly behaviorRevisionId: string;
  readonly outcome: string;
  readonly requiredAssertionCount: number;
  readonly executedAssertionCount: number;
  readonly attemptCount: number;
  readonly flakeState: string;
  readonly gateEffect: string;
  readonly exampleHash: string;
  readonly matrixHash: string;
  readonly artifactDigest: string;
  readonly proofUnitDigest: string | null;
  readonly runtimeBehaviorContextHash: string;
  readonly assertionEvidence: readonly BundleVerdictAssertionEvidence[];
  readonly attemptEvidence: readonly BundleVerdictAttemptEvidence[];
};

/**
 * The immutable evidence a bundle chains, collected once from append-only / durable
 * rows. `null` is a first-class "absent" — never inferred-present.
 */
export type ProofBundleEvidence = {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly run: BundleRunSection;
  readonly environment: BundleEnvironmentSection | null;
  readonly verdicts: readonly BundleVerdictSection[];
  /** bh-14a sealed resolution proofs for the run's issue loop — each self-verifiable. */
  readonly resolutionProofs: readonly SealedResolutionProof[];
};

export type BundleEntry = {
  readonly index: number;
  readonly kind: BundleEntryKind;
  /** sha256 of this section's canonical bytes — the "this_evidence" leaf. */
  readonly evidenceHash: string;
  /** sha256(prior_hash ‖ evidenceHash) — the running chain head at this entry. */
  readonly hash: string;
};

/** The deterministic exported bundle — no timestamps enter the chained bytes. */
export type ProofBundle = {
  readonly version: typeof PROOF_BUNDLE_VERSION;
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly evidence: ProofBundleEvidence;
  readonly entries: readonly BundleEntry[];
  /** The chain head over all sections — the Merkle-style root of the bundle. */
  readonly bundleHash: string;
};

export type ResolutionProofCheck = {
  readonly index: number;
  readonly issueLoopId: string;
  readonly valid: boolean;
  readonly divergedAt: string | null;
};

export type ProofBundleVerification = {
  readonly valid: boolean;
  /** The first entry kind whose recomputed hash diverged from the stored one. */
  readonly divergedAt: BundleEntryKind | null;
  readonly recomputedBundleHash: string;
  /** 0079 domain-invariant breaches (e.g. a `passed` verdict with executed < required). */
  readonly invariantViolations: readonly string[];
  /** Per-embedded-resolution-proof self-verification results. */
  readonly resolutionProofs: readonly ResolutionProofCheck[];
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sectionValue(evidence: ProofBundleEvidence, kind: BundleEntryKind): unknown {
  const sections: Record<BundleEntryKind, unknown> = {
    run: evidence.run,
    environment: evidence.environment,
    verdicts: evidence.verdicts,
    resolution_proofs: evidence.resolutionProofs,
  };
  return sections[kind];
}

/** Build the ordered, chained bundle entries from the collected evidence. */
export function buildBundleEntries(evidence: ProofBundleEvidence): BundleEntry[] {
  const entries: BundleEntry[] = [];
  let priorHashHex = sha256Hex(BUNDLE_CHAIN_GENESIS);
  for (const [index, kind] of BUNDLE_ENTRY_KINDS.entries()) {
    const evidenceHashHex = sha256Hex(canonicalJson(sectionValue(evidence, kind)));
    const chainHashHex = sha256Hex(`${priorHashHex}|${evidenceHashHex}`);
    entries.push({
      index,
      kind,
      evidenceHash: `sha256:${evidenceHashHex}`,
      hash: `sha256:${chainHashHex}`,
    });
    priorHashHex = chainHashHex;
  }
  return entries;
}

/** Assemble the deterministic exportable bundle from collected evidence. */
export function buildProofBundle(evidence: ProofBundleEvidence): ProofBundle {
  const entries = buildBundleEntries(evidence);
  const bundleHash = entries.at(-1)?.hash ?? `sha256:${sha256Hex(BUNDLE_CHAIN_GENESIS)}`;
  return {
    version: PROOF_BUNDLE_VERSION,
    orgId: evidence.orgId,
    projectId: evidence.projectId,
    runId: evidence.runId,
    evidence,
    entries,
    bundleHash,
  };
}

/**
 * The 0079 substrate invariant, re-checked at verify time so a re-chained bundle can
 * never launder a count detached from its FK-bound evidence. A re-chained bundle
 * still fails when a scalar differs from the embedded rows, and a passed verdict
 * additionally demands executed >= required >= 1.
 */
export function bundleInvariantViolations(evidence: ProofBundleEvidence): string[] {
  const violations: string[] = [];
  for (const verdict of evidence.verdicts) {
    const assertionIds = new Set<string>();
    let executed = 0;
    for (const assertion of verdict.assertionEvidence) {
      if (assertion.assertionId.length === 0 || assertionIds.has(assertion.assertionId)) {
        violations.push(`verdict ${verdict.verdictId} has a missing or duplicate assertion evidence id`);
        continue;
      }
      assertionIds.add(assertion.assertionId);
      if (assertion.executed) {
        if (typeof assertion.passed !== "boolean") {
          violations.push(`verdict ${verdict.verdictId} has an executed assertion without an outcome`);
        }
        executed += 1;
      } else if (assertion.passed !== null) {
        violations.push(`verdict ${verdict.verdictId} has an unexecuted assertion with an outcome`);
      }
    }
    const attemptOrdinals = new Set<number>();
    for (const attempt of verdict.attemptEvidence) {
      if (
        !Number.isInteger(attempt.attemptOrdinal) ||
        attempt.attemptOrdinal < 1 ||
        attemptOrdinals.has(attempt.attemptOrdinal)
      ) {
        violations.push(`verdict ${verdict.verdictId} has an invalid or duplicate attempt evidence ordinal`);
        continue;
      }
      attemptOrdinals.add(attempt.attemptOrdinal);
    }
    if (
      verdict.requiredAssertionCount !== verdict.assertionEvidence.length ||
      verdict.executedAssertionCount !== executed ||
      verdict.attemptCount !== verdict.attemptEvidence.length
    ) {
      violations.push(
        `verdict ${verdict.verdictId} count evidence mismatch: stored required/executed/attempt=` +
          `${verdict.requiredAssertionCount}/${verdict.executedAssertionCount}/${verdict.attemptCount}, evidence=` +
          `${verdict.assertionEvidence.length}/${executed}/${verdict.attemptEvidence.length}`,
      );
    }
    if (verdict.outcome !== "passed") continue;
    if (verdict.requiredAssertionCount < 1) {
      violations.push(`verdict ${verdict.verdictId} passed with required_assertion_count < 1`);
    } else if (verdict.executedAssertionCount < verdict.requiredAssertionCount) {
      violations.push(
        `verdict ${verdict.verdictId} passed with executed_assertion_count ` +
          `${verdict.executedAssertionCount} < required ${verdict.requiredAssertionCount}`,
      );
    }
  }
  return violations;
}

/**
 * Recompute the chain from the bundle's OWN evidence and compare it to the stored
 * entries + bundleHash. Any tampered evidence field re-derives a different section
 * hash, so the recomputed chain head no longer matches — reported invalid at the first
 * diverging entry. Additionally re-checks the 0079 domain invariant and re-verifies
 * every embedded resolution proof against its pinned evidence. Fully offline — no DB.
 */
export function verifyProofBundle(bundle: ProofBundle): ProofBundleVerification {
  const recomputed = buildBundleEntries(bundle.evidence);
  let divergedAt: BundleEntryKind | null = null;
  for (const [index, kind] of BUNDLE_ENTRY_KINDS.entries()) {
    if (recomputed[index]?.hash !== bundle.entries[index]?.hash) {
      divergedAt = kind;
      break;
    }
  }
  const recomputedBundleHash = recomputed.at(-1)?.hash ?? "";
  const invariantViolations = bundleInvariantViolations(bundle.evidence);
  const resolutionProofs = bundle.evidence.resolutionProofs.map((proof, index): ResolutionProofCheck => {
    // Offline self-verification: recompute the resolution-proof chain from its own
    // pinned evidence snapshot (bh-14a pins the exact rows the seal chained), so no DB
    // read is needed and a tampered sub-proof surfaces here.
    const check = verifyResolutionProof(proof.evidence, proof);
    return { index, issueLoopId: proof.issueLoopId, valid: check.valid, divergedAt: check.divergedAt };
  });
  const chainValid =
    divergedAt === null && recomputedBundleHash === bundle.bundleHash && bundle.version === PROOF_BUNDLE_VERSION;
  const valid = chainValid && invariantViolations.length === 0 && resolutionProofs.every((check) => check.valid);
  return { valid, divergedAt, recomputedBundleHash, invariantViolations, resolutionProofs };
}
