// cspell:ignore premerge proofbacked
// ds-6 — the FROZEN DesignDeliveryProofV1 read contract (design bucket §4 "queue /
// deploy / demo compounding", A4 ≡ demo).
//
// A DesignDeliveryProofV1 is a VERIFIED JOIN of already-authoritative sources — it is
// NEVER a denormalized "green" row and carries NO client-provided success boolean. Its
// equivalence verdict (`A4≡demo`) is DERIVED, fail-closed, from:
//   • the pre-merge design binding — the eager integrated matrix's design proof-unit
//     cells (`integration_proof_units`, keyed by the frozen six-input `deriveDesignProofKey`)
//     + the run-level render verdict (`design_render_land_verdicts`) + composed proof root;
//   • the production activation — the LIVE production `release_instances` row bound to the
//     SAME integration node, its `deploy.verified` terminal, and the proof-backed
//     `demo.completed` terminal (a full behavior pass).
//
// The GRAVEST fail-open this contract guards against is presenting a pre-merge screenshot
// as a successful live demo for DIFFERENT bytes. So the equivalence is `equivalent` ONLY
// when the LIVE artifact digest + the LIVE deployed scenario set EQUAL the pre-merge
// binding's, the deployed release binds to the exact pre-merge integration node, and the
// demo returned observable passing behavior. Any absent / mismatched / partial / ambiguous
// evidence yields a `blocked` verdict with a reason — never `equivalent`.
//
// Payload discipline (mirrors the design vocabulary freeze): content digests, stable ids,
// counts, and closed-vocab classifications only — NO rendered bytes, screenshots, secrets,
// or provider bodies. The screenshot is referenced by its CAS digest, never inlined.

import { z } from "zod";

export const DESIGN_DELIVERY_PROOF_SCHEMA_VERSION = "design_delivery_proof.v1" as const;

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Label = z.string().min(1).max(256);
const Id = z.string().min(1).max(256);
const Count = z.number().int().min(0);

/**
 * The six content-address inputs that fully determine a design proof's validity (ds-0's
 * frozen `deriveDesignProofKey`), carried EXACTLY so a consumer can recompute the key and
 * confirm the join was not fabricated. `environment` distinguishes the `pre_merge` binding
 * from the `production` re-derivation; every OTHER input must be identical across the two.
 */
export const DesignProofKeyComponentsV1 = z
  .object({
    releaseDigest: Sha256Digest,
    fragmentDigests: z.array(Sha256Digest).max(4096),
    adapterTarget: Label,
    environment: Label,
    scenarioKey: Label,
    artifactDigest: Sha256Digest,
  })
  .strict();
export type DesignProofKeyComponentsV1 = z.infer<typeof DesignProofKeyComponentsV1>;

/** One eager matrix cell of the pre-merge design binding: a scenario + its recorded render
 * verdict + the proof-unit that immutably records it, keyed by the derived proof key. */
export const DesignDeliveryCellV1 = z
  .object({
    scenarioKey: Label,
    /** The recorded design-render verdict for this scenario (fail-closed decode upstream). */
    renderVerdict: z.enum(["passed", "failed", "unknown"]),
    /** The A4 render screenshot referenced by its CAS digest — never inlined bytes. */
    screenshotDigest: Sha256Digest.optional(),
    /** The derived `sha256:` design proof key (deriveDesignProofKey over the six inputs). */
    designProofKey: Sha256Digest,
    /** The immutable integration proof-unit that records this cell. */
    proofUnitId: Id,
    /** Whether the cell REUSED an exact-key prior proof unit (true) or recorded fresh. */
    reused: z.boolean(),
  })
  .strict();
export type DesignDeliveryCellV1 = z.infer<typeof DesignDeliveryCellV1>;

/** The pre-merge design binding: the eager integrated matrix + its composed proof root. */
export const DesignDeliveryPreMergeV1 = z
  .object({
    integrationNodeId: Id,
    /** The composed Merkle root over the design proof-unit cells (fail-closed compose). */
    proofRoot: Sha256Digest,
    /** The run-level render verdict backbone this binding was recorded against. */
    releaseId: Id,
    designSystemId: Id,
    contractDigest: Sha256Digest,
    designContractVersion: Label,
    renderOutcome: z.enum(["passed", "failed_visual", "inconclusive_infrastructure", "not_applicable"]),
    adapterTarget: Label,
    /** The design-system artifact digest the eager matrix bound (the snapshot the cells were
     * keyed against) — the SAME-domain equality anchor compared against the deployed design
     * artifact digest (NOT the product deploy artifact). */
    artifactDigest: Sha256Digest,
    /** The sorted validated fragment-digest SET fed into `deriveDesignProofKey` — the real
     * sixth key input, carried so the proven `boundKey` is honest (never `[]`). */
    fragmentDigests: z.array(Sha256Digest).max(4096),
    /** The eager scenario set (sorted) the pre-merge matrix bound — the equality anchor. */
    scenarioKeys: z.array(Label).max(4096),
    cells: z.array(DesignDeliveryCellV1).max(4096),
  })
  .strict();
export type DesignDeliveryPreMergeV1 = z.infer<typeof DesignDeliveryPreMergeV1>;

/** The production activation identities: the live release, its deploy, and the demo verdict. */
export const DesignDeliveryProductionV1 = z
  .object({
    releaseInstanceId: Id,
    integrationNodeId: Id,
    provider: Label,
    environment: z.literal("production"),
    deploymentId: Id,
    /** The DEPLOYED design-system artifact digest — INDEPENDENTLY resolved from the live
     * design render state (same content domain as the pre-merge binding's `artifactDigest`),
     * NOT the product deploy blob. The equality anchor against the pre-merge snapshot. */
    artifactDigest: Sha256Digest,
    /** The live product-deploy artifact digest (`release_instances.artifact_digest`) — carried
     * for the trace only; a DIFFERENT content domain, so it is NEVER compared to the design
     * artifact digest above. */
    deployedProductDigest: Sha256Digest,
    /** The landed source ref the live release serves (the merged tip). */
    sourceRef: Label,
    /** The proof-backed demo's behavior tally (from `demo.completed`); no success boolean. */
    behaviorCount: Count,
    behaviorsPassed: Count,
    behaviorsFailed: Count,
    /** The deployed scenario set (sorted), INDEPENDENTLY resolved from the live design render
     * state — NOT copied from pre-merge. The real equality check against the pre-merge set. */
    scenarioKeys: z.array(Label).max(4096),
  })
  .strict();
export type DesignDeliveryProductionV1 = z.infer<typeof DesignDeliveryProductionV1>;

/**
 * The equivalence verdict — DERIVED, never client-provided. `equivalent` (A4 ≡ demo) is the
 * ONLY value that asserts the delivered design system is the one that was verified pre-merge;
 * every other value carries a closed-vocab `blockedReason`. A verified join therefore cannot
 * "pass" by omission — absence resolves to `blocked`.
 */
export const DesignDeliveryEquivalenceV1 = z.enum([
  "equivalent",
  "blocked_pre_merge_incomplete",
  "blocked_no_live_release",
  "blocked_artifact_mismatch",
  "blocked_scenario_mismatch",
  "blocked_node_mismatch",
  "blocked_render_not_passed",
  "blocked_demo_not_passed",
  "blocked_deploy_unverified",
]);
export type DesignDeliveryEquivalenceV1 = z.infer<typeof DesignDeliveryEquivalenceV1>;

/**
 * The frozen strict DesignDeliveryProofV1. NOTE: `equivalence` is derived by
 * {@link buildDesignDeliveryProof}; the schema never accepts a boolean success flag from an
 * untrusted client — the read route only ever SERVES this shape, never ingests it.
 */
export const DesignDeliveryProofV1 = z
  .object({
    version: z.literal(1),
    schemaVersion: z.literal(DESIGN_DELIVERY_PROOF_SCHEMA_VERSION),
    orgId: Id,
    projectId: Id,
    runId: Id,
    integrationNodeId: Id,
    equivalence: DesignDeliveryEquivalenceV1,
    /** The pre-merge design binding (undefined ⇒ no eager matrix bound → blocked). */
    preMerge: DesignDeliveryPreMergeV1.nullable(),
    /** The production activation (undefined ⇒ no live release/deploy/demo → blocked). */
    production: DesignDeliveryProductionV1.nullable(),
    /** The exact six-input proof-key components proven equal across pre-merge/production
     * (present ONLY on an `equivalent` verdict). */
    boundKey: DesignProofKeyComponentsV1.nullable(),
  })
  .strict();
export type DesignDeliveryProofV1 = z.infer<typeof DesignDeliveryProofV1>;

/** Parse an untrusted value into a DesignDeliveryProofV1 (fail-closed; used only in tests /
 * cross-boundary decode — the producer builds the shape directly). */
export function parseDesignDeliveryProof(value: unknown): DesignDeliveryProofV1 {
  return DesignDeliveryProofV1.parse(value);
}
