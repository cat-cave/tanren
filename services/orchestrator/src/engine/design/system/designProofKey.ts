// ds-0 — the design PROOF-KEY derivation (foundation).
//
// The deterministic content address the design-aware gate (ds-4) + speculative
// merge queue (ds-6) key proof REUSE off (design bucket §1 "proof reuse keyed by
// fragment, target, environment, scenario, and artifact digests"; §4 speculative
// queue: "include release, fragment, adapter, environment and scenario digests in
// the proof key"). Two runs whose SIX components match EXACTLY share a proof; any
// drift in any component recomputes — so a stale proof can never be reused.
//
// The key is derived by a single canonical serialization (stable field order,
// sorted fragment digests) hashed with sha256. It carries NO bytes, secrets, or
// provider bodies — only content digests + stable labels. ds-0 owns the
// derivation so ds-4/ds-6 compute the SAME key from the SAME inputs; the columns
// that anchor its components live on the design_* backbone (schemaDesignSystems).

import { createHash } from "node:crypto";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** The six components that fully determine a design proof's validity. */
export interface DesignProofKeyInput {
  /** The immutable release the proof was produced against (content digest). */
  readonly releaseDigest: string;
  /** The composed fragment-graph digests (order-independent — sorted before hashing). */
  readonly fragmentDigests: readonly string[];
  /** The adapter/target the artifact projects onto (stable key, e.g. "web-react"). */
  readonly adapterTarget: string;
  /** The environment the proof ran in (e.g. "pre_merge", "preview"). */
  readonly environment: string;
  /** The scenario matrix cell the proof covers (component × theme × viewport …). */
  readonly scenarioKey: string;
  /** The artifact the proof was produced against (content digest). */
  readonly artifactDigest: string;
}

/** Raised when a proof-key component is malformed — fail-closed, never a silent key. */
export class DesignProofKeyInputError extends Error {
  constructor(readonly issue: string) {
    super(`design proof-key input is invalid: ${issue}`);
    this.name = "DesignProofKeyInputError";
  }
}

function assertDigest(label: string, value: string): void {
  if (!SHA256_DIGEST.test(value)) {
    throw new DesignProofKeyInputError(`${label} must be a sha256:<64-hex> digest`);
  }
}

function assertLabel(label: string, value: string): void {
  if (value.length === 0 || value.length > 256) {
    throw new DesignProofKeyInputError(`${label} must be a non-empty label ≤ 256 chars`);
  }
}

/**
 * Derive the canonical `sha256:` proof-reuse key for a design proof. Deterministic
 * + order-independent over the fragment set. Any change to ANY of the six
 * components yields a different key (proof recomputes); an exact match reuses.
 */
export function deriveDesignProofKey(input: DesignProofKeyInput): string {
  assertDigest("releaseDigest", input.releaseDigest);
  assertDigest("artifactDigest", input.artifactDigest);
  assertLabel("adapterTarget", input.adapterTarget);
  assertLabel("environment", input.environment);
  assertLabel("scenarioKey", input.scenarioKey);
  for (const digest of input.fragmentDigests) {
    assertDigest("fragmentDigests[]", digest);
  }
  // Sort the fragment digests so composition order does not perturb the key (the
  // fragment SET, not its ordering, determines the projection).
  const fragments = [...input.fragmentDigests].sort();
  // Canonical JSON-array body: a stable, one-to-one serialization so no two
  // distinct inputs can collide by field-boundary ambiguity.
  const body = JSON.stringify([
    "tanren.design-proof-key.v1",
    input.releaseDigest,
    input.artifactDigest,
    input.adapterTarget,
    input.environment,
    input.scenarioKey,
    fragments,
  ]);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
