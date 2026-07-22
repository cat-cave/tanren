// bh-14a — the resolution proof seal. A `tanren-resolution-proof.v1` document is
// a tamper-evident HASH-CHAIN over the full issue-loop evidence: each ordered
// entry hashes `(prior_hash ‖ this_evidence)` (sha256), so editing any single
// linked evidence row re-derives a different entry hash and breaks every hash
// after it. This module owns ONLY the pure, deterministic build/verify — the DB
// evidence collection, persistence, and event emission live in
// `resolutionProofSealer.ts`. Keeping the chain math pure lets a non-DB
// composition test exercise the exact seal + verify + badge logic the live
// authority path runs.

import { createHash } from "node:crypto";

export const RESOLUTION_PROOF_VERSION = "tanren-resolution-proof.v1";

/** Domain-separated chain root so a proof hash can never collide with a section hash. */
const PROOF_CHAIN_GENESIS = `${RESOLUTION_PROOF_VERSION}:genesis`;

/**
 * The seal fires only when an issue loop reaches a terminal state: a fully
 * verified authorized/waived close, or a blocked resolution. `needs_attention`
 * is a hold, not a terminal, and never seals.
 */
export const RESOLUTION_PROOF_TERMINALS = ["authorized_verified_closed", "blocked"] as const;
export type ResolutionProofTerminal = (typeof RESOLUTION_PROOF_TERMINALS)[number];

/**
 * The chain's fixed entry order. Every seal chains all ten sections in this
 * order regardless of which evidence is present; an absent section chains its
 * canonical `null`, so a missing baseline is itself tamper-evident.
 */
export const PROOF_ENTRY_KINDS = [
  "issue_loop",
  "triage",
  "spec_origins",
  "merge",
  "deployment",
  "baseline",
  "counterfactual",
  "production_symptom",
  "resolution_decision",
  "source_sync",
] as const;
export type ProofEntryKind = (typeof PROOF_ENTRY_KINDS)[number];

// Only stable identity evidence — never the loop's mutable lifecycle `state`,
// which legitimately advances after a blocked seal and would otherwise make a
// proof read invalid without any tampering.
export type IssueLoopSection = {
  readonly issueLoopId: string;
  readonly fingerprint: string | null;
  readonly sourceRevision: string | null;
  readonly sourceFindingId: string | null;
  readonly providerObjectId: string | null;
};

export type TriageSection = {
  readonly taskId: string;
  readonly status: string | null;
  readonly agentKind: string | null;
};

export type SpecOriginSection = {
  readonly id: string;
  readonly specId: string;
  readonly role: string;
  readonly attemptNumber: number | null;
  readonly ordinal: number | null;
};

export type MergeSection = {
  readonly mergeSha: string;
  readonly authorityAuditId: string | null;
};

export type DeploymentSection = {
  readonly releaseInstanceId: string;
  readonly artifactDigest: string | null;
  readonly url: string | null;
  readonly state: string | null;
  readonly sourceRef: string | null;
};

export type EvidenceRunSection = {
  readonly verificationRunId: string;
  readonly artifactDigest: string | null;
  readonly classification: string | null;
  /** bh-15: the locked behavior-context digest this stage ran against, shown per stage. */
  readonly runtimeBehaviorContextHash?: string | null;
};

export type ProductionSymptomSection = {
  readonly verificationRunId: string;
  readonly classification: string | null;
  readonly outcome: "passed" | "failed" | "inconclusive";
  readonly artifactDigest: string | null;
  readonly preparedHeadSha: string | null;
  readonly probedUrl: string | null;
  readonly assertions: ReadonlyArray<{ readonly id: string; readonly outcome: string }>;
  /** bh-15: the locked behavior-context digest this stage ran against, shown per stage. */
  readonly runtimeBehaviorContextHash?: string | null;
};

export type ResolutionDecisionSection = {
  readonly decisionId: string;
  readonly decision: "authorized" | "blocked" | "needs_attention" | "waived";
  readonly inputSnapshotHash: string;
  readonly authorityVersion: string;
};

export type SourceSyncSection = {
  readonly outboxId: string;
  readonly operation: string;
  readonly state: string;
  readonly providerReceipt: unknown;
  readonly readback: unknown;
};

/**
 * The immutable evidence a proof chains, collected once from append-only /
 * durable rows. `null` is a first-class "absent" — never inferred-present.
 */
export type ResolutionProofEvidence = {
  readonly orgId: string;
  readonly projectId: string;
  readonly issueLoopId: string;
  readonly resolutionJobId: string;
  readonly resolutionDecisionId: string;
  readonly sections: {
    readonly issue_loop: IssueLoopSection;
    readonly triage: TriageSection | null;
    readonly spec_origins: readonly SpecOriginSection[];
    readonly merge: MergeSection | null;
    readonly deployment: DeploymentSection | null;
    readonly baseline: EvidenceRunSection | null;
    readonly counterfactual: EvidenceRunSection | null;
    readonly production_symptom: ProductionSymptomSection | null;
    readonly resolution_decision: ResolutionDecisionSection;
    readonly source_sync: SourceSyncSection | null;
  };
};

export type ProofEntry = {
  readonly index: number;
  readonly kind: ProofEntryKind;
  /** sha256 of this section's canonical bytes — the "this_evidence" leaf. */
  readonly evidenceHash: string;
  /** sha256(prior_hash ‖ evidenceHash) — the running chain head at this entry. */
  readonly hash: string;
};

/**
 * The truth badges are deliberately SEPARATE, never collapsed into a single
 * pass/fail. A cosmetic fix can merge, deploy, and stay reachable (all green)
 * while its symptom verification fails and its resolution is blocked — the
 * badges must show exactly that split.
 */
export type ResolutionProofBadges = {
  readonly gate: "passed" | "absent";
  readonly merged: "passed" | "absent";
  readonly deploy: "bound" | "absent";
  readonly demo: "reachable" | "unreachable" | "absent";
  readonly symptom: "passed" | "failed" | "inconclusive" | "absent";
  readonly source: "verified_closed" | "pending" | "absent";
};

/** The deterministic sealed proof — no timestamps enter the chained bytes. */
export type SealedResolutionProof = {
  readonly version: typeof RESOLUTION_PROOF_VERSION;
  readonly terminal: ResolutionProofTerminal;
  readonly orgId: string;
  readonly projectId: string;
  readonly issueLoopId: string;
  readonly resolutionJobId: string;
  readonly resolutionDecisionId: string;
  readonly badges: ResolutionProofBadges;
  readonly entries: readonly ProofEntry[];
  readonly proofHash: string;
  /**
   * The exact evidence snapshot chained at seal time. It PINS which rows a later
   * re-verification re-reads (e.g. the specific spec-origin ids), so a legitimate
   * later append — a bh-13 repair origin added after a blocked seal — does not
   * read as tampering, while an edit to any pinned row still does.
   */
  readonly evidence: ResolutionProofEvidence;
};

export type ProofVerification = {
  readonly valid: boolean;
  /** The first entry kind whose recomputed hash diverged from the sealed one. */
  readonly divergedAt: ProofEntryKind | null;
  readonly recomputedProofHash: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic, key-sorted JSON so a section's bytes never depend on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function sectionValue(evidence: ResolutionProofEvidence, kind: ProofEntryKind): unknown {
  return evidence.sections[kind];
}

/** Build the ordered, chained proof entries from the collected evidence. */
export function buildProofEntries(evidence: ResolutionProofEvidence): ProofEntry[] {
  const entries: ProofEntry[] = [];
  let priorHashHex = sha256Hex(PROOF_CHAIN_GENESIS);
  for (const [index, kind] of PROOF_ENTRY_KINDS.entries()) {
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

export function deriveProofBadges(evidence: ResolutionProofEvidence): ResolutionProofBadges {
  const { merge, deployment, production_symptom: symptom, source_sync: sourceSync } = evidence.sections;
  return {
    gate: merge !== null && merge.authorityAuditId !== null ? "passed" : "absent",
    merged: merge !== null && merge.mergeSha.length > 0 ? "passed" : "absent",
    deploy: deployment !== null && deployment.artifactDigest !== null ? "bound" : "absent",
    demo: demoBadge(deployment),
    symptom: symptom === null ? "absent" : symptom.outcome,
    source: sourceBadge(sourceSync),
  };
}

function demoBadge(deployment: DeploymentSection | null): ResolutionProofBadges["demo"] {
  if (deployment === null || deployment.url === null) return "absent";
  return deployment.state === "live" ? "reachable" : "unreachable";
}

function sourceBadge(sourceSync: SourceSyncSection | null): ResolutionProofBadges["source"] {
  if (sourceSync === null) return "absent";
  return sourceSync.state === "verified" ? "verified_closed" : "pending";
}

/** Seal the deterministic proof; the store adds sealedAt metadata around this core. */
export function buildResolutionProof(
  evidence: ResolutionProofEvidence,
  terminal: ResolutionProofTerminal,
): SealedResolutionProof {
  const entries = buildProofEntries(evidence);
  const proofHash = entries.at(-1)?.hash ?? `sha256:${sha256Hex(PROOF_CHAIN_GENESIS)}`;
  return {
    version: RESOLUTION_PROOF_VERSION,
    terminal,
    orgId: evidence.orgId,
    projectId: evidence.projectId,
    issueLoopId: evidence.issueLoopId,
    resolutionJobId: evidence.resolutionJobId,
    resolutionDecisionId: evidence.resolutionDecisionId,
    badges: deriveProofBadges(evidence),
    entries,
    proofHash,
    evidence,
  };
}

/**
 * Recompute the chain from the CURRENT evidence and compare it to the sealed
 * proof. Any tampered linked row re-derives a different section hash, so the
 * recomputed chain head no longer matches — the proof is reported invalid at the
 * first diverging entry.
 */
export function verifyResolutionProof(
  currentEvidence: ResolutionProofEvidence,
  sealed: SealedResolutionProof,
): ProofVerification {
  const recomputed = buildProofEntries(currentEvidence);
  let divergedAt: ProofEntryKind | null = null;
  for (const [index, kind] of PROOF_ENTRY_KINDS.entries()) {
    if (recomputed[index]?.hash !== sealed.entries[index]?.hash) {
      divergedAt = kind;
      break;
    }
  }
  const recomputedProofHash = recomputed.at(-1)?.hash ?? sealed.proofHash;
  return {
    valid: divergedAt === null && recomputedProofHash === sealed.proofHash,
    divergedAt,
    recomputedProofHash,
  };
}
