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

/** Identity that a multimodal probe must inherit from the locked run. */
export interface SymptomProbeRuntimeBinding {
  readonly orgId: string;
  readonly projectId: string;
  readonly contractId: string;
  readonly verificationRunId: string;
  readonly artifactDigest: Digest;
  readonly planId: string;
  readonly runtimeBehaviorContextHash: string;
  readonly releaseInstanceId: string;
}

export interface SymptomProbeExecution {
  readonly observedObservation: SymptomObservation;
  readonly evidence: readonly SymptomProbeEvidence[];
  readonly timingMs: number;
  readonly outcome?: "passed" | "failed" | "inconclusive";
}

export interface SymptomProbeDriver {
  execute(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contractId?: string;
    readonly contract: SymptomContractV1;
    readonly verificationRunId: string;
    readonly runtimeBinding?: SymptomProbeRuntimeBinding;
  }): Promise<SymptomProbeExecution>;
}

export interface SymptomBaselineInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly contractId: string;
  readonly contract: SymptomContractV1;
  readonly verificationRunId: string;
  readonly runtimeBinding?: SymptomProbeRuntimeBinding;
}

/** A stage-owned assertion target for running a locked symptom contract. */
export interface SymptomVerificationInput extends SymptomBaselineInput {
  readonly expectedObservation: SymptomObservation;
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

/** Evidence and assertion materialized by the shared SP·5 probe path. */
export interface SymptomVerificationResult {
  readonly orgId: string;
  readonly projectId: string;
  readonly issueLoopId: string;
  readonly contractId: string;
  readonly verificationRunId: string;
  readonly expectedHash: Digest;
  readonly observedHash: Digest;
  readonly outcome: SymptomAssertionOutcome;
  readonly timingMs: number;
  readonly evidence: readonly SymptomEvidenceRef[];
  readonly assertionId: string;
}

/** Parse a canonical HTTP URL, optionally requiring one live origin. */
export function canonicalHttpLocation(value: unknown, liveOrigin?: string): URL {
  const absolute = typeof value === "string" && URL.canParse(value);
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    /[?#]$/u.test(value) ||
    (!absolute && !value.startsWith("/")) ||
    !URL.canParse(value, liveOrigin)
  ) {
    throw new Error("HTTP location is not canonical");
  }
  const location = new URL(value, liveOrigin);
  const expectedOrigin = liveOrigin === undefined ? undefined : new URL(liveOrigin).origin;
  const canonical =
    liveOrigin === undefined
      ? value === location.origin
        ? location.origin
        : location.toString()
      : absolute
        ? value === location.origin
          ? location.origin
          : location.toString()
        : location.pathname + location.search;
  if (
    !/^https?:$/u.test(location.protocol) ||
    [location.username, location.password, location.hash].some(Boolean) ||
    (expectedOrigin !== undefined && location.origin !== expectedOrigin) ||
    value !== canonical
  ) {
    throw new Error("HTTP location is not a canonical same-origin URL");
  }
  return location;
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
