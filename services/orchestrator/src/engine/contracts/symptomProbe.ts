import type { CanonicalBody, Digest } from "./cas.js";
import { canonicalJson, contentDigestOf } from "./cas.js";
import type { RedactionClass } from "./runtimeVerificationPlan.js";
import { SymptomContractV1Schema, type SymptomContractV1 } from "./symptomContract.js";

export type SymptomObservation = Record<string, unknown>;
export type SymptomBaselineOutcome = "reproduced" | "not_reproduced" | "inconclusive";
export type SymptomAssertionOutcome = "passed" | "failed" | "inconclusive";

export interface SymptomProbeEvidence {
  readonly kind: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly redactionClass: RedactionClass;
  readonly retentionClass?: string;
}

export interface SymptomProbeExecution {
  readonly observedObservation: SymptomObservation;
  readonly evidence: readonly SymptomProbeEvidence[];
  readonly timingMs: number;
  readonly outcome?: "inconclusive";
}

export interface SymptomProbeDriver {
  execute(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contract: SymptomContractV1;
    readonly verificationRunId: string;
  }): Promise<SymptomProbeExecution>;
}

export interface SymptomBaselineInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly contractId: string;
  readonly contract: SymptomContractV1;
  readonly verificationRunId: string;
}

export interface SymptomEvidenceRef {
  readonly id: string;
  readonly digest: Digest;
  readonly byteSize: number;
  readonly mediaType: string;
}

export interface SymptomBaselineResult {
  readonly orgId: string;
  readonly projectId: string;
  readonly issueLoopId: string;
  readonly contractId: string;
  readonly verificationRunId: string;
  readonly expectedHash: Digest;
  readonly observedHash: Digest;
  readonly outcome: SymptomAssertionOutcome;
  readonly baselineOutcome: SymptomBaselineOutcome;
  readonly timingMs: number;
  readonly evidence: readonly SymptomEvidenceRef[];
  readonly assertionId: string;
}

function toCanonicalObservation(value: unknown): CanonicalBody {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("symptom observations cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toCanonicalObservation(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries: readonly (readonly [string, CanonicalBody])[] = Object.keys(record)
      .sort()
      .map((key) => [key, toCanonicalObservation(record[key])] as const);
    return Object.fromEntries(entries);
  }
  throw new TypeError(`symptom observations cannot contain ${typeof value}`);
}

export function canonicalSymptomObservationBytes(observation: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(toCanonicalObservation(observation)));
}

export function symptomObservationHash(observation: unknown): Digest {
  return contentDigestOf(canonicalSymptomObservationBytes(observation));
}

export function parseSymptomContract(contract: SymptomContractV1): SymptomContractV1 {
  return SymptomContractV1Schema.parse(contract);
}
