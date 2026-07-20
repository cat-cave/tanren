// ds-6 pure, DB-free fail-closed JOIN gates. The coordinator + read route are thin DB
// shells over these functions: EVERY fail-closed decision (an incomplete eager matrix, a
// non-passing render, no live release, a node/artifact/scenario mismatch, an unverified
// deploy, a 200-but-failing demo) is made HERE over already-gathered evidence, so every
// negative control is asserted WITHOUT a database. The gravest fail-open — a pre-merge
// screenshot presented as a live demo for DIFFERENT bytes — is closed by the artifact
// (integration-node) + scenario-set equality gates below.

import type {
  DesignDeliveryEquivalenceV1,
  DesignDeliveryPreMergeV1,
  DesignDeliveryProductionV1,
  DesignDeliveryProofV1,
  DesignProofKeyComponentsV1,
} from "./designDeliveryProof.js";
import { DESIGN_DELIVERY_PROOF_SCHEMA_VERSION } from "./designDeliveryProof.js";

/** The already-gathered evidence the equivalence derivation joins. Every field is resolved
 * by an org-scoped read (or a fake in a unit test) BEFORE this pure module sees it. */
export interface DesignDeliveryEvidence {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly integrationNodeId: string;
  /** The pre-merge design binding (undefined ⇒ no eager matrix bound). */
  readonly preMerge: DesignDeliveryPreMergeV1 | undefined;
  /** The production activation identities (undefined ⇒ no live release/deploy/demo). */
  readonly production: DesignDeliveryProductionV1 | undefined;
  /** Whether the NEWEST terminal deploy event for the run is a verification (not a later
   * failure). Resolved fail-closed by the read; a stale/absent terminal ⇒ false. */
  readonly deployVerified: boolean;
}

/** Sorted multiset equality (order-insensitive, duplicate-sensitive) over labels. */
function sameScenarioSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** Every eager cell recorded a real PASS — no partial matrix, no `unknown`, no empty set. */
function preMergeCellsAllPassed(preMerge: DesignDeliveryPreMergeV1): boolean {
  return (
    preMerge.cells.length > 0 &&
    preMerge.scenarioKeys.length > 0 &&
    preMerge.cells.length === preMerge.scenarioKeys.length &&
    preMerge.cells.every((cell) => cell.renderVerdict === "passed") &&
    // Internal consistency: the recorded cells cover EXACTLY the bound scenario set.
    sameScenarioSet(
      preMerge.cells.map((cell) => cell.scenarioKey),
      preMerge.scenarioKeys,
    )
  );
}

/** A demo is successful only when EVERY declared behavior passed (rv-18 `demoIsSuccessful`). */
function demoIsSuccessful(production: DesignDeliveryProductionV1): boolean {
  return (
    production.behaviorCount > 0 &&
    production.behaviorsFailed === 0 &&
    production.behaviorsPassed === production.behaviorCount
  );
}

/**
 * Derive the fail-closed equivalence verdict. The checks run in a PRIORITY order so the
 * blocked reason is the earliest unmet precondition; `equivalent` is reachable ONLY when
 * every precondition holds. There is no vacuous pass: an absent pre-merge/production, an
 * empty matrix, or an empty scenario set all resolve to a `blocked_*` reason.
 */
export function deriveEquivalence(evidence: DesignDeliveryEvidence): DesignDeliveryEquivalenceV1 {
  const { preMerge, production } = evidence;

  // 1. Pre-merge design binding must exist, render `passed`, and its eager matrix complete.
  if (
    preMerge === undefined ||
    preMerge.integrationNodeId !== evidence.integrationNodeId ||
    preMerge.cells.length === 0 ||
    preMerge.scenarioKeys.length === 0
  ) {
    return "blocked_pre_merge_incomplete";
  }
  if (preMerge.renderOutcome !== "passed" || !preMergeCellsAllPassed(preMerge)) {
    return "blocked_render_not_passed";
  }

  // 2. A LIVE production release bound to the SAME integration node must exist.
  if (production === undefined) {
    return "blocked_no_live_release";
  }
  if (production.integrationNodeId !== preMerge.integrationNodeId) {
    return "blocked_node_mismatch";
  }
  // The design system artifact digest the demo exercised must be the SAME immutable artifact
  // the pre-merge matrix bound (a different design artifact = different bytes claimed).
  if (production.artifactDigest !== preMerge.artifactDigest) {
    return "blocked_artifact_mismatch";
  }

  // 3. The deploy must be VERIFIED (newest terminal is `deploy.verified`).
  if (!evidence.deployVerified) {
    return "blocked_deploy_unverified";
  }

  // 4. The deployed scenario set must EQUAL the pre-merge eager matrix (no missing/extra cell).
  if (!sameScenarioSet(production.scenarioKeys, preMerge.scenarioKeys)) {
    return "blocked_scenario_mismatch";
  }

  // 5. The proof-backed demo must return observable passing behavior (a 200-but-failing demo,
  // an unobserved product, or a zero-behavior release all fail here — never a fabricated pass).
  if (!demoIsSuccessful(production)) {
    return "blocked_demo_not_passed";
  }

  return "equivalent";
}

/**
 * The six-input design proof key components proven EQUAL across pre-merge and production —
 * emitted ONLY on an `equivalent` verdict (else null). `environment` is normalized to
 * `production` to denote the proven live re-derivation; every OTHER input is the pre-merge
 * binding's, which the equality gates above have confirmed the live release carries.
 */
function boundKeyFor(
  equivalence: DesignDeliveryEquivalenceV1,
  preMerge: DesignDeliveryPreMergeV1 | undefined,
): DesignProofKeyComponentsV1 | null {
  if (equivalence !== "equivalent" || preMerge === undefined) return null;
  return {
    releaseDigest: preMerge.contractDigest,
    // The REAL sorted validated fragment-digest set fed into `deriveDesignProofKey` (never
    // an empty placeholder) — so the proven six-tuple is honest.
    fragmentDigests: [...preMerge.fragmentDigests],
    adapterTarget: preMerge.adapterTarget,
    environment: "production",
    scenarioKey: [...preMerge.scenarioKeys].sort().join(","),
    artifactDigest: preMerge.artifactDigest,
  };
}

/**
 * Assemble the frozen DesignDeliveryProofV1 from gathered evidence — the SOLE constructor.
 * The equivalence is DERIVED here (no client success boolean); the pre-merge/production
 * sub-objects are carried verbatim so a reader can audit the join, and `boundKey` appears
 * only when the join proved equivalent.
 */
export function buildDesignDeliveryProof(evidence: DesignDeliveryEvidence): DesignDeliveryProofV1 {
  const equivalence = deriveEquivalence(evidence);
  return {
    version: 1,
    schemaVersion: DESIGN_DELIVERY_PROOF_SCHEMA_VERSION,
    orgId: evidence.orgId,
    projectId: evidence.projectId,
    runId: evidence.runId,
    integrationNodeId: evidence.integrationNodeId,
    equivalence,
    preMerge: evidence.preMerge ?? null,
    production: evidence.production ?? null,
    boundKey: boundKeyFor(equivalence, evidence.preMerge),
  };
}
