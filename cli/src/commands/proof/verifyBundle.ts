// rv-24 — the OFFLINE, self-contained proof-bundle verifier behind `tanren proof
// verify <bundle>`. It is a DELIBERATELY INDEPENDENT re-implementation of the
// `tanren-proof-bundle.v1` (and embedded `tanren-resolution-proof.v1`) hash-chain math:
// it depends on nothing but `node:crypto`, so a bundle is verified by RECOMPUTING every
// section hash from the bundle's OWN bytes — never by trusting a stored hash or a
// `valid` flag — with no network and no DB. An independent verifier must not import the
// server code that produced the bundle, hence the copy. The canonical-JSON + chain rules
// below are byte-identical to the orchestrator's; a committed fixture bundle
// (built by the orchestrator) is verified in the CLI tests to pin the two together.

import { createHash } from "node:crypto";

const BUNDLE_VERSION = "tanren-proof-bundle.v1";
const BUNDLE_ENTRY_KINDS = ["run", "environment", "verdicts", "resolution_proofs"] as const;
const BUNDLE_GENESIS = `${BUNDLE_VERSION}:genesis`;

const RESOLUTION_PROOF_VERSION = "tanren-resolution-proof.v1";
const RESOLUTION_PROOF_GENESIS = `${RESOLUTION_PROOF_VERSION}:genesis`;
const PROOF_ENTRY_KINDS = [
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

export type ResolutionProofCheck = {
  readonly index: number;
  readonly issueLoopId: string;
  readonly valid: boolean;
  readonly divergedAt: string | null;
};

export type BundleVerifyResult = {
  readonly valid: boolean;
  /** Populated when the document is not a well-formed v1 bundle. */
  readonly structuralError: string | null;
  readonly divergedAt: string | null;
  readonly storedBundleHash: string | null;
  readonly recomputedBundleHash: string | null;
  readonly invariantViolations: readonly string[];
  readonly resolutionProofs: readonly ResolutionProofCheck[];
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic, key-sorted JSON — byte-identical to the orchestrator's canonicalJson. */
function canonicalJson(value: unknown): string {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The stored chain hash at entry `i`, or undefined when the entry is malformed. */
function storedHashAt(entries: readonly unknown[], i: number): unknown {
  const entry = entries[i];
  return isObject(entry) ? entry["hash"] : undefined;
}

/** Recompute one hash-chain from ordered section values; return the entry hashes. */
function chainHashes(genesis: string, sections: readonly unknown[]): string[] {
  const hashes: string[] = [];
  let priorHashHex = sha256Hex(genesis);
  for (const section of sections) {
    const evidenceHashHex = sha256Hex(canonicalJson(section));
    const chainHashHex = sha256Hex(`${priorHashHex}|${evidenceHashHex}`);
    hashes.push(`sha256:${chainHashHex}`);
    priorHashHex = chainHashHex;
  }
  return hashes;
}

function bundleSectionValues(evidence: Record<string, unknown>): unknown[] {
  return [
    evidence["run"],
    evidence["environment"] ?? null,
    evidence["verdicts"] ?? [],
    evidence["resolutionProofs"] ?? [],
  ];
}

/** Re-check the 0079 domain invariant: a `passed` verdict demands executed >= required >= 1. */
function invariantViolations(evidence: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const verdicts = asArray(evidence["verdicts"]);
  for (const raw of verdicts) {
    if (!isObject(raw) || raw["outcome"] !== "passed") continue;
    const required = Number(raw["requiredAssertionCount"]);
    const executed = Number(raw["executedAssertionCount"]);
    const id = String(raw["verdictId"]);
    if (!(required >= 1)) {
      violations.push(`verdict ${id} passed with required_assertion_count < 1`);
    } else if (!(executed >= required)) {
      violations.push(`verdict ${id} passed with executed_assertion_count ${executed} < required ${required}`);
    }
  }
  return violations;
}

/** Offline self-verify of one embedded resolution proof against its own pinned evidence. */
function verifyResolutionProof(proof: Record<string, unknown>, index: number): ResolutionProofCheck {
  const issueLoopId = typeof proof["issueLoopId"] === "string" ? proof["issueLoopId"] : "";
  const evidence = proof["evidence"];
  const storedEntries = asArray(proof["entries"]);
  if (!isObject(evidence)) {
    return { index, issueLoopId, valid: false, divergedAt: PROOF_ENTRY_KINDS[0] };
  }
  const sections = evidence["sections"];
  if (!isObject(sections)) {
    return { index, issueLoopId, valid: false, divergedAt: PROOF_ENTRY_KINDS[0] };
  }
  const recomputed = chainHashes(
    RESOLUTION_PROOF_GENESIS,
    PROOF_ENTRY_KINDS.map((kind) => sections[kind] ?? null),
  );
  for (const [i, kind] of PROOF_ENTRY_KINDS.entries()) {
    if (storedHashAt(storedEntries, i) !== recomputed[i]) {
      return { index, issueLoopId, valid: false, divergedAt: kind };
    }
  }
  const validRoot = recomputed.at(-1) === proof["proofHash"];
  return { index, issueLoopId, valid: validRoot, divergedAt: validRoot ? null : (PROOF_ENTRY_KINDS.at(-1) ?? null) };
}

const EMPTY: BundleVerifyResult = {
  valid: false,
  structuralError: null,
  divergedAt: null,
  storedBundleHash: null,
  recomputedBundleHash: null,
  invariantViolations: [],
  resolutionProofs: [],
};

/**
 * Verify a parsed proof-bundle document fully offline. Recomputes the bundle hash-chain
 * from the document's own evidence, re-checks the domain invariant, and self-verifies
 * every embedded resolution proof. Returns `valid: false` with a `structuralError` when
 * the document is not a well-formed v1 bundle.
 */
export function verifyBundleDocument(doc: unknown): BundleVerifyResult {
  if (!isObject(doc)) return { ...EMPTY, structuralError: "bundle is not an object" };
  if (doc["version"] !== BUNDLE_VERSION) {
    return { ...EMPTY, structuralError: `unexpected bundle version: ${String(doc["version"])}` };
  }
  const evidence = doc["evidence"];
  if (!isObject(evidence) || !isObject(evidence["run"])) {
    return { ...EMPTY, structuralError: "bundle evidence is missing its run section" };
  }
  const storedEntries = asArray(doc["entries"]);
  const storedBundleHash = typeof doc["bundleHash"] === "string" ? doc["bundleHash"] : null;

  const recomputed = chainHashes(BUNDLE_GENESIS, bundleSectionValues(evidence));
  let divergedAt: string | null = null;
  for (const [i, kind] of BUNDLE_ENTRY_KINDS.entries()) {
    if (storedHashAt(storedEntries, i) !== recomputed[i]) {
      divergedAt = kind;
      break;
    }
  }
  const recomputedBundleHash = recomputed.at(-1) ?? null;
  const violations = invariantViolations(evidence);
  const proofs = asArray(evidence["resolutionProofs"]);
  const resolutionProofs = proofs.map((proof, index) =>
    isObject(proof)
      ? verifyResolutionProof(proof, index)
      : { index, issueLoopId: "", valid: false, divergedAt: PROOF_ENTRY_KINDS[0] },
  );

  const chainValid = divergedAt === null && recomputedBundleHash === storedBundleHash;
  const valid = chainValid && violations.length === 0 && resolutionProofs.every((check) => check.valid);
  return {
    valid,
    structuralError: null,
    divergedAt,
    storedBundleHash,
    recomputedBundleHash,
    invariantViolations: violations,
    resolutionProofs,
  };
}
