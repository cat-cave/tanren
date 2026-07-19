// bh-13 — stable identity for the no-attempt-cap repair fixed point.
//
// This deliberately accepts only the immutable symptom contract, production
// classification, and an explicit set of stable assertion fields. It never
// accepts a decision, probe, verification-run, timestamp, or other
// execution-scoped identifier.
// cspell:ignore errorclass errorcode errorkind errormessage errortype failureclass failurecode failurekind failuremessage failuretype nodekind symptomkind

import { createHash } from "node:crypto";
import { canonicalizeFailureSignature } from "./convergenceSignatureCanonical.js";

export type RepairFailureAssertion = {
  readonly expectedObservation: unknown;
  readonly observedObservation: unknown;
  readonly outcome: string;
};

export type RepairFailureSignatureInput = {
  readonly contractId: string;
  readonly contractHash: string;
  readonly classification: string;
  readonly assertions: readonly RepairFailureAssertion[];
};

/**
 * The sole observation fields allowed into a repair fixed-point key.
 *
 * `contractId`/`contractHash` carry the immutable symptom identity and
 * `classification`/`outcome` carry the production verdict. The observation adds
 * only stable failure discriminators: protocol status, failure/error
 * class/type/code, and the stage or node that failed. Every other field is
 * ignored, regardless of its name or nesting, so newly-added run ids, attempt
 * counters, timestamps, UUIDs, artifact references, and delivery ordering
 * cannot make a recurring failure look new.
 */
const STABLE_OBSERVATION_FIELDS = new Set([
  "body",
  "code",
  "error",
  "errorclass",
  "errorcode",
  "errorkind",
  "errormessage",
  "errortype",
  "failureclass",
  "failurecode",
  "failurekind",
  "failuremessage",
  "failuretype",
  "kind",
  "message",
  "nodekind",
  "reason",
  "stage",
  "status",
  "symptom",
  "symptomkind",
  "type",
]);

const DIAGNOSTIC_FIELDS = new Set(["body", "errormessage", "failuremessage", "message", "reason"]);
const ATTEMPT_ORDINAL = /\battempt(?:\s*(?:number|no\.?|#))?\s*[:=#-]?\s*\d+\b/giu;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalJsonValue(item))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  throw new Error(`repair routing has a non-JSON assertion value (${typeof value})`);
}

function normalizeFieldName(field: string): string {
  return field.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

function canonicalDiagnostic(value: string): string {
  return canonicalizeFailureSignature(value).replaceAll(ATTEMPT_ORDINAL, "attempt <ordinal>");
}

function stableObservation(value: unknown, field?: string): unknown {
  if (typeof value === "string" && field !== undefined && DIAGNOSTIC_FIELDS.has(field)) {
    return canonicalDiagnostic(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stableObservation(item, field))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [normalizeFieldName(key), child] as const)
        .filter(([key]) => STABLE_OBSERVATION_FIELDS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableObservation(child, key)]),
    );
  }
  return canonicalJsonValue(value);
}

function canonicalAssertion(assertion: RepairFailureAssertion): unknown {
  return canonicalJsonValue({
    // The contract hash is the immutable expected-observation identity. Do not
    // hash the raw sample copy: its only role here is operator evidence.
    outcome: assertion.outcome,
    observed: stableObservation(assertion.observedObservation),
  });
}

/**
 * Produce the sole fixed-point key for repair routing.
 *
 * The observation projection is an allowlist, not a volatile-field denylist.
 * That keeps a repeated failure stable when a later probe adds fresh execution
 * metadata, while a changed stable symptom value remains a distinct failure that
 * can be routed as a successor.
 */
export function repairFailureSignature(input: RepairFailureSignatureInput): string {
  const assertions = input.assertions
    .map(canonicalAssertion)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = JSON.stringify(
    canonicalJsonValue({
      version: "tanren-repair-failure-signature.v2",
      contractId: input.contractId,
      contractHash: input.contractHash,
      classification: input.classification,
      assertions,
    }),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
