// ds-7 — the frozen DesignAdapterConformanceReceiptV1 contract.
//
// The adversarial conformance receipt every framework adapter (Bevy, SwiftUI,
// Jetpack Compose, Flutter, React Native, generic-web, document-media — plus
// the existing web-react) must produce for the EXACT artifact + scenario matrix
// it publishes. `passed` is positive-only: EVERY critical proof requirement
// must have decisive evidence AND EVERY negative control must report the
// expected finding. A receipt that omits a required proof, suppresses a
// negative control, or is computed over a DIFFERENT artifact/matrix digest than
// the one actually published NEVER passes (proof≡effect, trap #7).
//
// The receipt is CONSUMED by the existing ds-4 gate (resolveDesignRenderGate →
// inconclusive_infrastructure when a required target has no passed receipt on
// the exact published coordinate). It is NOT itself a MergeAuthority and never
// substitutes for an A4 verdict — it is durable evidence the gate reads.
//
// FOUNDATION-ONLY: this module freezes the Zod schema, the parser, and the
// canonical SHA-256 digest over the schema-normalized body. Per-adapter bodies
// + the conformance runner live in their own modules.

import { createHash } from "node:crypto";
import { z } from "zod";

/** The closed set of targets the registry admits (mirrors the data-model CHECK). */
export const DESIGN_ADAPTER_CONFORMANCE_TARGETS = [
  "web-react",
  "generic-web",
  "bevy",
  "swiftui",
  "jetpack-compose",
  "flutter",
  "react-native",
  "document-media",
] as const;
export type DesignAdapterConformanceTarget = (typeof DESIGN_ADAPTER_CONFORMANCE_TARGETS)[number];

export const DesignAdapterConformanceTargetSchema = z.enum(DESIGN_ADAPTER_CONFORMANCE_TARGETS);

/** The closed outcome set — `passed` is the ONLY green state. */
export const DESIGN_ADAPTER_CONFORMANCE_OUTCOMES = [
  "passed",
  "failed",
  "inconclusive_infrastructure",
  "not_applicable",
] as const;
const DesignAdapterConformanceOutcomeSchema = z.enum(DESIGN_ADAPTER_CONFORMANCE_OUTCOMES);

export const DESIGN_ADAPTER_CONFORMANCE_SCHEMA_VERSION = "design_adapter_conformance.v1" as const;
export const DESIGN_ADAPTER_CONFORMANCE_VERSION = 1 as const;

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u, "expected a sha256:<64-hex> content digest");
const NonBlankString = z.string().min(1).max(512);
const CapabilityKey = z.string().min(1).max(120);

/** Thrown when a blob does not parse as a valid receipt. Fail-closed. */
export class DesignAdapterConformanceReceiptCorruptError extends Error {
  constructor(
    readonly issues: string,
    options?: { cause?: unknown },
  ) {
    super(`design adapter conformance receipt is corrupt: ${issues}`, options);
    this.name = "DesignAdapterConformanceReceiptCorruptError";
  }
}

/** A resolved capability the adapter claimed against the required set. */
export const ResolvedDesignCapabilityV1 = z
  .object({
    capability: CapabilityKey,
    /** True only when the adapter's projection genuinely emits the capability (positive evidence). */
    supported: z.boolean(),
    /** Content-addressed proof (e.g. file digest) the projection carries for this capability. */
    evidenceDigest: Sha256Digest,
  })
  .strict();
export type ResolvedDesignCapabilityV1 = z.infer<typeof ResolvedDesignCapabilityV1>;

/** A critical proof requirement the conformance runner MUST satisfy. */
export const DesignAdapterCriticalProofV1 = z
  .object({
    key: NonBlankString,
    kind: z.enum(["build", "token", "accessibility", "interaction", "render", "export"]),
    /** The content-addressed evidence the runner observed (file digest, checkpoint digest, …). */
    evidenceDigest: Sha256Digest,
    /** `passed` ONLY on decisive positive evidence — never vacuous, never a default. */
    passed: z.boolean(),
  })
  .strict();
export type DesignAdapterCriticalProofV1 = z.infer<typeof DesignAdapterCriticalProofV1>;

/** A positive conformance case the runner exercised (must pass). */
export const DesignAdapterPositiveCaseV1 = z
  .object({
    key: NonBlankString,
    description: z.string().min(1).max(2000),
    evidenceDigest: Sha256Digest,
    passed: z.boolean(),
  })
  .strict();
export type DesignAdapterPositiveCaseV1 = z.infer<typeof DesignAdapterPositiveCaseV1>;

/** A mandatory negative control — a broken input the adapter's validators MUST flag. */
export const DesignAdapterNegativeControlV1 = z
  .object({
    key: NonBlankString,
    description: z.string().min(1).max(2000),
    /** The check code the adapter's validator MUST emit for this broken input. */
    expectFindingCode: NonBlankString,
    /** `passed` ONLY when the validator reported the expected finding (decisive). */
    passed: z.boolean(),
  })
  .strict();
export type DesignAdapterNegativeControlV1 = z.infer<typeof DesignAdapterNegativeControlV1>;

/**
 * The frozen receipt. `artifactDigest` and `scenarioMatrixDigest` are the EXACT
 * content addresses the runner conformed against — proof≡effect (trap #7).
 * `passed` is true ONLY when:
 *   1. outcome === "passed",
 *   2. every resolved capability is `supported`,
 *   3. every critical proof is `passed`,
 *   4. every positive case is `passed`,
 *   5. every negative control is `passed` (the validator caught the regression),
 *   6. the required-capability multiset is non-empty AND exactly satisfied.
 */
export const DesignAdapterConformanceReceiptV1 = z
  .object({
    version: z.literal(DESIGN_ADAPTER_CONFORMANCE_VERSION),
    schemaVersion: z.literal(DESIGN_ADAPTER_CONFORMANCE_SCHEMA_VERSION),
    target: DesignAdapterConformanceTargetSchema,
    adapterVersion: NonBlankString,
    /** The EXACT published artifact manifest digest this receipt covers. */
    artifactDigest: Sha256Digest,
    /** The EXACT published scenario-matrix digest this receipt covers. */
    scenarioMatrixDigest: Sha256Digest,
    requiredCapabilities: z.array(CapabilityKey).min(1).max(256),
    resolvedCapabilities: z.array(ResolvedDesignCapabilityV1).max(256),
    criticalProofs: z.array(DesignAdapterCriticalProofV1).min(1).max(256),
    positiveCases: z.array(DesignAdapterPositiveCaseV1).min(1).max(256),
    negativeControls: z.array(DesignAdapterNegativeControlV1).min(1).max(256),
    outcome: DesignAdapterConformanceOutcomeSchema,
    /** Free-form notes (a failure reason, an infra caveat). Never a pass authority. */
    notes: z.string().max(4000).default(""),
  })
  .strict();
export type DesignAdapterConformanceReceiptV1 = z.infer<typeof DesignAdapterConformanceReceiptV1>;

/** Parse + validate a receipt blob, throwing on any malformed shape. */
export function parseDesignAdapterConformanceReceipt(value: unknown): DesignAdapterConformanceReceiptV1 {
  const result = DesignAdapterConformanceReceiptV1.safeParse(value);
  if (!result.success) {
    throw new DesignAdapterConformanceReceiptCorruptError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
      { cause: result.error },
    );
  }
  return normalizeDesignAdapterConformanceReceipt(result.data);
}

/**
 * The POSITIVE-ONLY pass predicate — true ONLY when every required capability,
 * every critical proof, every positive case, AND every negative control is
 * decisively satisfied. A receipt with zero required capabilities, an unsupported
 * capability, or a negative control the validator failed to flag NEVER passes
 * (vacuous-truth defense, trap #4). The predicate is PURE so it is unit-tested
 * without Postgres — the fail-closed decision table is in source, not SQL.
 */
export function receiptPasses(receipt: DesignAdapterConformanceReceiptV1): boolean {
  if (receipt.outcome !== "passed") return false;
  if (receipt.requiredCapabilities.length === 0) return false;
  if (receipt.resolvedCapabilities.some((capability) => !capability.supported)) return false;
  if (receipt.criticalProofs.some((proof) => !proof.passed)) return false;
  if (receipt.positiveCases.some((positive) => !positive.passed)) return false;
  if (receipt.negativeControls.some((control) => !control.passed)) return false;
  // EXACT multiset: every required capability is resolved, no extras, no missing.
  const required = new Map<string, number>();
  for (const capability of receipt.requiredCapabilities) {
    required.set(capability, (required.get(capability) ?? 0) + 1);
  }
  const resolved = new Map<string, number>();
  for (const capability of receipt.resolvedCapabilities) {
    if (!capability.supported) return false;
    resolved.set(capability.capability, (resolved.get(capability.capability) ?? 0) + 1);
  }
  if (required.size !== resolved.size) return false;
  for (const [key, count] of required) {
    if (resolved.get(key) !== count) return false;
  }
  return true;
}

/** Deep-clone a parsed receipt into its canonical field order (round-trip identity). */
export function normalizeDesignAdapterConformanceReceipt(
  receipt: DesignAdapterConformanceReceiptV1,
): DesignAdapterConformanceReceiptV1 {
  return {
    version: DESIGN_ADAPTER_CONFORMANCE_VERSION,
    schemaVersion: DESIGN_ADAPTER_CONFORMANCE_SCHEMA_VERSION,
    target: receipt.target,
    adapterVersion: receipt.adapterVersion,
    artifactDigest: receipt.artifactDigest,
    scenarioMatrixDigest: receipt.scenarioMatrixDigest,
    requiredCapabilities: [...receipt.requiredCapabilities],
    resolvedCapabilities: receipt.resolvedCapabilities.map((capability) => ({ ...capability })),
    criticalProofs: receipt.criticalProofs.map((proof) => ({ ...proof })),
    positiveCases: receipt.positiveCases.map((positive) => ({ ...positive })),
    negativeControls: receipt.negativeControls.map((control) => ({ ...control })),
    outcome: receipt.outcome,
    notes: receipt.notes,
  };
}

/** Content-address a receipt — the `receipt_digest` persisted on the run row. */
export function designAdapterConformanceReceiptDigest(value: unknown): string {
  const body = JSON.stringify(["tanren.design-adapter-conformance.v1", parseDesignAdapterConformanceReceipt(value)]);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

/**
 * Content-address a scenario matrix (the `scenarioMatrixDigest` the receipt binds to).
 * The body is the schema-normalized matrix JSON — proof≡effect (trap #7): the
 * runner PROVES conformance over the EXACT matrix it published.
 */
export function designAdapterScenarioMatrixDigest(scenarios: readonly unknown[]): string {
  const body = JSON.stringify(["tanren.design-adapter.scenario-matrix.v1", [...scenarios]]);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
