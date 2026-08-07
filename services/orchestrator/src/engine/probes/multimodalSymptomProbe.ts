import { z } from "zod";
import { canonicalJson, contentDigestOf, type CanonicalBody, type Digest } from "../contracts/cas.js";
import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
  DriverObservation,
  RenderEvidenceKind,
} from "../contracts/runtimeVerificationAdapters.js";
import type { ComparisonOperator } from "../contracts/runtimeVerificationPlan.js";
import {
  canonicalHttpLocation,
  type SymptomProbeDriver,
  type SymptomProbeEvidence,
  type SymptomProbeExecution,
  type SymptomProbeRuntimeBinding,
} from "../contracts/symptomProbe.js";
import type { SymptomContractV1 } from "../contracts/symptomContract.js";
import { evaluateAssertion } from "../verification/acceptance/assertionEvaluator.js";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const observationKind = z.enum(["http", "json", "dom", "accessibility_tree", "visual", "console", "network"]);
const evidenceKind = z.enum(["screenshot", "dom", "computed_styles", "a11y_tree", "console", "network"]);
const comparisonOperator = z.custom<ComparisonOperator>(
  (value) =>
    typeof value === "string" &&
    "equals|not_equals|less_than|less_than_or_equal|greater_than|greater_than_or_equal|between|matches_schema|satisfies_predicate|contains|not_contains|has_cardinality|is_unique|exactly_once|eventually|before|after|causes|responds_with|matches|has_no_effect"
      .split("|")
      .includes(value),
  "invalid multimodal comparison operator",
);
const redactionClass = z.enum(["none", "secret", "credential", "token", "pii", "sensitive", "hash_only"]);
const nonempty = z.string().min(1);
const canonical: z.ZodType<CanonicalBody> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(canonical), z.record(z.string(), canonical)]),
);
const evidenceRef = z.strictObject({ kind: evidenceKind, mediaType: nonempty });
const evidenceSpec = evidenceRef.extend({ redactionClass, retentionClass: nonempty.optional() }).strict();
const assertionSpec = z.strictObject({
  assertionId: nonempty,
  observationKind,
  subject: nonempty,
  comparisonOperator,
  expected: canonical,
  evidence: z.array(evidenceRef).min(1),
});
const assertionObservation = z.strictObject({
  assertionId: nonempty,
  observationKind,
  subject: nonempty,
  expected: canonical,
  actual: canonical,
  outcome: z.enum(["passed", "failed"]),
  evidenceDigests: z.array(digestSchema).min(1),
});
const evidenceDigest = evidenceRef.extend({ digest: digestSchema }).strict();
const conclusiveObservation = z.strictObject({
  version: z.literal("multimodal_symptom_observation.v1"),
  planId: digestSchema,
  runtimeBehaviorContextHash: digestSchema,
  outcome: z.enum(["passed", "failed"]),
  assertions: z.array(assertionObservation).min(1),
  evidence: z.array(evidenceDigest).min(1),
});
const unavailableObservation = z.strictObject({
  version: z.literal("multimodal_symptom_observation.v1"),
  planId: digestSchema,
  runtimeBehaviorContextHash: digestSchema,
  outcome: z.literal("inconclusive"),
  reason: z.enum(["inconclusive_external", "inconclusive_infrastructure"]),
});

export const MultimodalSymptomTargetV1Schema = z.strictObject({
  kind: z.literal("multimodal_browser"),
  version: z.literal(1),
  url: z
    .string()
    .url()
    .refine((value) => /^https?:/u.test(value), "multimodal browser target must use HTTP(S)"),
  planId: digestSchema,
  runtimeBehaviorContextHash: digestSchema,
  assertions: z.array(assertionSpec).min(1),
  evidence: z.array(evidenceSpec).min(1),
});

export type MultimodalSymptomTargetV1 = z.infer<typeof MultimodalSymptomTargetV1Schema>;
type AssertionObservation = z.infer<typeof assertionObservation>;
type EvidenceDigest = z.infer<typeof evidenceDigest>;
type EvidenceTuple = { readonly kind: string; readonly mediaType: string };
type ValidatedEvidence = {
  readonly spec: MultimodalSymptomTargetV1["evidence"][number];
  readonly payload: SymptomProbeEvidence;
};
export interface MultimodalSymptomRuntimeInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly contractId: string;
  readonly verificationRunId: string;
  readonly artifactDigest: Digest;
  readonly target: MultimodalSymptomTargetV1;
}
export interface MultimodalSymptomRuntime {
  execute(input: MultimodalSymptomRuntimeInput): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}
export type MultimodalLiveOriginResolver = (input: {
  readonly orgId: string;
  readonly projectId: string;
  readonly releaseInstanceId: string;
}) => Promise<string>;
export type MultimodalSymptomObservation = z.infer<typeof conclusiveObservation>;
/** The generic multimodal seam; it validates provider output before SP-5 effects. */
export class MultimodalSymptomProbe implements SymptomProbeDriver {
  public constructor(
    private readonly runtime: MultimodalSymptomRuntime,
    private readonly liveOrigins?: MultimodalLiveOriginResolver,
  ) {}
  public async execute(input: Parameters<SymptomProbeDriver["execute"]>[0]): Promise<SymptomProbeExecution> {
    const target = parseMultimodalSymptomTarget(input.contract.target);
    const binding = requireRuntimeBinding(target, input.runtimeBinding);
    assertRequestBinding(binding, input);
    if (this.liveOrigins !== undefined) {
      const liveOrigin = canonicalHttpLocation(
        await this.liveOrigins({
          orgId: input.orgId,
          projectId: input.projectId,
          releaseInstanceId: binding.releaseInstanceId,
        }),
      ).origin;
      canonicalHttpLocation(target.url, liveOrigin);
    }
    const startedAt = Date.now();
    const result = await this.runtime.execute({
      orgId: input.orgId,
      projectId: input.projectId,
      contractId: binding.contractId,
      verificationRunId: input.verificationRunId,
      artifactDigest: binding.artifactDigest,
      target,
    });
    if (result.kind === "unavailable") return unavailable(target, result, elapsed(startedAt));
    if (result.kind !== "executed") throw new Error("multimodal symptom runtime returned an unknown result kind");
    if (!Array.isArray(result.providerChecksums) || result.providerChecksums.length > 0) {
      throw new Error("multimodal browser result cannot discard provider checksums");
    }

    const observations = validateObservations(target, result.observations);
    const captured = validateEvidence(target, result.capture);
    const evidenceDigests = captured.map(({ spec, payload }) => {
      if (payload.retentionClass !== undefined && payload.retentionClass !== spec.retentionClass) {
        throw new Error(`multimodal evidence ${evidenceLabel(spec)} has an unlocked retention class`);
      }
      return {
        kind: evidenceKind.parse(payload.kind),
        mediaType: payload.mediaType,
        digest: contentDigestOf(payload.bytes),
      } satisfies EvidenceDigest;
    });
    const assertions: AssertionObservation[] = target.assertions.map((assertion) => {
      const observation = observations.get(assertion.subject);
      if (observation === undefined) throw new Error("multimodal assertion observation is missing");
      const outcome = evaluateAssertion(assertion.comparisonOperator, observation.value, assertion.expected)
        ? "passed"
        : "failed";
      return {
        assertionId: assertion.assertionId,
        observationKind: assertion.observationKind,
        subject: assertion.subject,
        expected: assertion.expected,
        actual: observation.value,
        outcome,
        evidenceDigests: assertion.evidence.map((ref) => {
          const evidence = findEvidence(evidenceDigests, ref);
          if (evidence === undefined) throw new Error("multimodal assertion evidence is missing");
          return evidence.digest;
        }),
      };
    });
    const observedObservation: MultimodalSymptomObservation = {
      version: "multimodal_symptom_observation.v1",
      planId: target.planId,
      runtimeBehaviorContextHash: target.runtimeBehaviorContextHash,
      outcome: assertions.every((assertion) => assertion.outcome === "passed") ? "passed" : "failed",
      assertions,
      evidence: evidenceDigests,
    };
    return {
      observedObservation,
      evidence: captured.map(({ spec, payload }) => ({
        kind: payload.kind,
        mediaType: payload.mediaType,
        bytes: payload.bytes,
        redactionClass: payload.redactionClass,
        ...(spec.retentionClass === undefined ? {} : { retentionClass: spec.retentionClass }),
      })),
      timingMs: elapsed(startedAt),
      outcome: observedObservation.outcome,
    };
  }
}
/** Validate the locked run identity before entering a runtime or writing proof. */
export function validateMultimodalRequest(input: {
  readonly orgId: string;
  readonly projectId: string;
  readonly contractId: string;
  readonly verificationRunId: string;
  readonly contract: SymptomContractV1;
  readonly runtimeBinding?: SymptomProbeRuntimeBinding;
}): void {
  if (input.contract.target["kind"] !== "multimodal_browser") return;
  const target = parseMultimodalSymptomTarget(input.contract.target);
  const binding = requireRuntimeBinding(target, input.runtimeBinding);
  assertRequestBinding(binding, input);
}

/** Revalidate a driver result immediately before any CAS/artifact/assertion effect. */
export function validateMultimodalExecution(
  contract: SymptomContractV1,
  binding: SymptomProbeRuntimeBinding | undefined,
  execution: SymptomProbeExecution,
): "passed" | "failed" | "inconclusive" {
  const target = parseMultimodalSymptomTarget(contract.target);
  requireRuntimeBinding(target, binding);
  if (execution.outcome === "inconclusive") {
    const observed = parseObservation(
      unavailableObservation,
      execution.observedObservation,
      "multimodal unavailable observation is not a public proof reason",
    );
    requireObservationBinding(target, observed);
    if (!Array.isArray(execution.evidence) || execution.evidence.length > 0) {
      throw new Error("unavailable multimodal runtime cannot own evidence");
    }
    return "inconclusive";
  }
  if (execution.outcome !== "passed" && execution.outcome !== "failed") {
    throw new Error("multimodal symptom execution requires an explicit verdict");
  }
  const observed = parseObservation(
    conclusiveObservation,
    execution.observedObservation,
    "multimodal conclusive observation is not a valid proof manifest",
  );
  requireObservationBinding(target, observed);
  const captured = validateEvidence(target, execution.evidence);
  const digests = captured.map(({ spec, payload }) => {
    if (payload.retentionClass !== spec.retentionClass) {
      throw new Error(`multimodal evidence ${evidenceLabel(spec)} has unlocked retention class`);
    }
    return {
      kind: spec.kind,
      mediaType: spec.mediaType,
      digest: contentDigestOf(payload.bytes),
    } satisfies EvidenceDigest;
  });
  assertExactEvidenceManifest(observed.evidence, digests);

  const assertionIds = new Set<string>();
  for (const assertion of observed.assertions) {
    if (assertionIds.has(assertion.assertionId)) throw new Error("duplicate multimodal assertion proof");
    assertionIds.add(assertion.assertionId);
  }
  const assertions = observed.assertions;
  if (assertions.length !== target.assertions.length) {
    throw new Error("multimodal assertion multiset mismatch");
  }
  const outcomes = target.assertions.map((spec) => {
    const item = assertions.find((assertion) => assertion.assertionId === spec.assertionId);
    if (item === undefined) throw new Error("multimodal assertion is missing");
    const expectedOutcome = evaluateAssertion(spec.comparisonOperator, item.actual, spec.expected)
      ? "passed"
      : "failed";
    const expectedEvidence = spec.evidence.map((ref) => {
      const evidence = findEvidence(digests, ref);
      if (evidence === undefined) throw new Error("multimodal assertion references missing evidence");
      return evidence.digest;
    });
    if (
      item.observationKind !== spec.observationKind ||
      item.subject !== spec.subject ||
      canonicalJson(item.expected) !== canonicalJson(spec.expected) ||
      item.outcome !== expectedOutcome ||
      !sameMultiset(item.evidenceDigests, expectedEvidence)
    ) {
      throw new Error("multimodal assertion does not match its locked proof");
    }
    return expectedOutcome;
  });
  const outcome = outcomes.every((item) => item === "passed") ? "passed" : "failed";
  if (execution.outcome !== outcome || observed.outcome !== outcome) {
    throw new Error("multimodal execution verdict does not match its assertion manifest");
  }
  return outcome;
}
export function parseMultimodalSymptomTarget(raw: SymptomContractV1["target"]): MultimodalSymptomTargetV1 {
  const target = MultimodalSymptomTargetV1Schema.parse(raw);
  const assertionIds = new Set<string>();
  const subjectKinds = new Map<string, string>();
  const declaredEvidence = uniqueEvidence(target.evidence, "target");
  const referencedEvidence: EvidenceTuple[] = [];
  for (const assertion of target.assertions) {
    if (assertionIds.has(assertion.assertionId)) throw new Error("duplicate multimodal assertion id");
    assertionIds.add(assertion.assertionId);
    const previousKind = subjectKinds.get(assertion.subject);
    if (previousKind !== undefined && previousKind !== assertion.observationKind) {
      throw new Error("multimodal subject has conflicting observation kinds");
    }
    subjectKinds.set(assertion.subject, assertion.observationKind);
    const requiredKind = requiredEvidence[assertion.observationKind];
    if (!assertion.evidence.some((ref) => ref.kind === requiredKind)) {
      throw new Error(`multimodal assertion lacks required ${requiredKind} evidence`);
    }
    uniqueEvidence(assertion.evidence, "assertion");
    for (const ref of assertion.evidence) {
      if (findEvidence(declaredEvidence, ref) === undefined) {
        throw new Error("multimodal assertion references undeclared evidence");
      }
      referencedEvidence.push(ref);
    }
  }
  for (const evidence of declaredEvidence) {
    if (findEvidence(referencedEvidence, evidence) === undefined) {
      throw new Error("multimodal target declares unreferenced evidence");
    }
  }
  return target;
}

const requiredEvidence: Record<z.infer<typeof observationKind>, RenderEvidenceKind> = {
  http: "network",
  json: "network",
  dom: "dom",
  accessibility_tree: "a11y_tree",
  visual: "screenshot",
  console: "console",
  network: "network",
};

function validateObservations(
  target: MultimodalSymptomTargetV1,
  raw: readonly DriverObservation[],
): ReadonlyMap<string, DriverObservation> {
  if (!Array.isArray(raw)) throw new Error("multimodal runtime observations must be an array");
  const expectedKinds = new Map(target.assertions.map((assertion) => [assertion.subject, assertion.observationKind]));
  const observed = new Map<string, DriverObservation>();
  for (const item of raw) {
    if (item === null || typeof item !== "object") throw new Error("multimodal observation is malformed");
    if (typeof item.subject !== "string" || observed.has(item.subject)) {
      throw new Error("multimodal observation subject is missing or duplicated");
    }
    if (expectedKinds.get(item.subject) !== item.observationKind) {
      throw new Error("multimodal observation kind does not match the locked assertion");
    }
    if (typeof item.observedAt !== "string" || item.observedAt.length === 0) {
      throw new Error("multimodal observation timestamp is missing");
    }
    if (!canonical.safeParse(item.value).success) throw new Error("multimodal observation value is not canonical");
    observed.set(item.subject, item);
  }
  if (observed.size !== expectedKinds.size) throw new Error("multimodal observation multiset mismatch");
  return observed;
}

function validateEvidence(
  target: MultimodalSymptomTargetV1,
  raw: readonly SymptomProbeEvidence[] | undefined,
): readonly ValidatedEvidence[] {
  if (!Array.isArray(raw)) throw new Error("multimodal runtime returned no evidence capture array");
  const actual = uniqueEvidence(raw, "runtime");
  if (actual.length !== target.evidence.length) throw new Error("multimodal evidence multiset mismatch");
  return target.evidence.map((spec) => {
    const payload = findEvidence(actual, spec);
    if (payload === undefined) throw new Error("multimodal runtime omitted evidence");
    if (!(payload.bytes instanceof Uint8Array) || payload.bytes.byteLength === 0) {
      throw new Error("multimodal evidence has no bytes");
    }
    if (payload.redactionClass !== spec.redactionClass) {
      throw new Error("multimodal evidence has an unlocked redaction class");
    }
    return { spec, payload };
  });
}

function uniqueEvidence<T extends EvidenceTuple>(values: readonly T[], source: string): readonly T[] {
  const unique: T[] = [];
  for (const value of values) {
    const parsed = evidenceRef.safeParse({ kind: value.kind, mediaType: value.mediaType });
    if (!parsed.success) throw new Error(`invalid ${source} multimodal evidence tuple`);
    if (findEvidence(unique, parsed.data) !== undefined) throw new Error(`duplicate ${source} multimodal evidence`);
    unique.push(value);
  }
  return unique;
}

function assertExactEvidenceManifest(actual: readonly EvidenceDigest[], expected: readonly EvidenceDigest[]): void {
  if (
    !sameMultiset(
      actual.map((item) => evidenceManifestKey(item)),
      expected.map((item) => evidenceManifestKey(item)),
    )
  )
    throw new Error("multimodal observation evidence digest multiset mismatch");
}

function sameMultiset(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const counts = new Map<string, number>();
  for (const value of expected) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of actual) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function findEvidence<T extends EvidenceTuple>(values: readonly T[], ref: EvidenceTuple): T | undefined {
  return values.find((item) => item.kind === ref.kind && item.mediaType === ref.mediaType);
}

function requireRuntimeBinding(
  target: MultimodalSymptomTargetV1,
  binding: SymptomProbeRuntimeBinding | undefined,
): SymptomProbeRuntimeBinding {
  if (
    binding === undefined ||
    binding.orgId.length === 0 ||
    binding.projectId.length === 0 ||
    binding.contractId.length === 0 ||
    binding.verificationRunId.length === 0 ||
    binding.releaseInstanceId.length === 0 ||
    !digestSchema.safeParse(binding.artifactDigest).success ||
    binding.planId !== target.planId ||
    binding.runtimeBehaviorContextHash !== target.runtimeBehaviorContextHash
  ) {
    throw new Error("multimodal symptom target does not match the authoritative runtime binding");
  }
  return binding;
}

function assertRequestBinding(
  binding: SymptomProbeRuntimeBinding,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contractId?: string;
    readonly verificationRunId: string;
  },
): void {
  if (
    input.contractId === undefined ||
    binding.orgId !== input.orgId ||
    binding.projectId !== input.projectId ||
    binding.contractId !== input.contractId ||
    binding.verificationRunId !== input.verificationRunId
  ) {
    throw new Error("multimodal request is outside its locked org/project/run/contract binding");
  }
}

function requireObservationBinding(
  target: MultimodalSymptomTargetV1,
  observed: { readonly planId: string; readonly runtimeBehaviorContextHash: string },
): void {
  if (observed.planId !== target.planId || observed.runtimeBehaviorContextHash !== target.runtimeBehaviorContextHash) {
    throw new Error("multimodal observation does not match its locked plan/context");
  }
}

function parseObservation<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
}

function unavailable(
  target: MultimodalSymptomTargetV1,
  result: AdapterUnavailableResult,
  timingMs: number,
): SymptomProbeExecution {
  if (result.outcome !== "inconclusive_external" && result.outcome !== "inconclusive_infrastructure") {
    throw new Error("multimodal runtime returned an invalid unavailable outcome");
  }
  return {
    observedObservation: {
      version: "multimodal_symptom_observation.v1",
      planId: target.planId,
      runtimeBehaviorContextHash: target.runtimeBehaviorContextHash,
      outcome: "inconclusive",
      reason: result.outcome,
    },
    evidence: [],
    timingMs,
    outcome: "inconclusive",
  };
}

const evidenceLabel = (item: EvidenceTuple): string => JSON.stringify([item.kind, item.mediaType]);
const evidenceManifestKey = (item: EvidenceDigest): string => JSON.stringify([item.kind, item.mediaType, item.digest]);
const elapsed = (startedAt: number): number => Math.max(0, Date.now() - startedAt);
