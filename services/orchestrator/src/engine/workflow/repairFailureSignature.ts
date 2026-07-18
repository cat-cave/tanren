// bh-13 — stable identity for the no-attempt-cap repair fixed point.
//
// This deliberately accepts only the immutable symptom contract plus the
// production classification and assertion *shape*. It never accepts a decision,
// probe, verification-run, timestamp, or other execution-scoped identifier.
// cspell:ignore attemptid createdat finishedat observedat probeid runid sequencenumber spanid startedat timems timestampms traceid updatedat verificationrunid

import { createHash } from "node:crypto";

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

const VOLATILE_OBSERVATION_FIELDS = new Set([
  "attempt",
  "attemptid",
  "counter",
  "createdat",
  "duration",
  "elapsed",
  "finishedat",
  "monotonic",
  "nonce",
  "observedat",
  "probeid",
  "requestid",
  "runid",
  "sequence",
  "sequencenumber",
  "spanid",
  "startedat",
  "time",
  "timems",
  "timestamp",
  "timestampms",
  "traceid",
  "updatedat",
  "verificationrunid",
]);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_OBSERVATION_FIELDS.has(normalizeFieldName(key)))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
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

function canonicalAssertion(assertion: RepairFailureAssertion): unknown {
  return canonicalValue({
    expected: assertion.expectedObservation,
    observed: assertion.observedObservation,
    outcome: assertion.outcome,
  });
}

/**
 * Produce the sole fixed-point key for repair routing.
 *
 * `expected`/`observed` retain semantic fields but strip explicitly execution
 * scoped fields before hashing. That keeps a repeated cosmetic failure stable
 * when a new probe emits fresh timestamps or ids, while a changed symptom value
 * remains a distinct failure that can be routed as a successor.
 */
export function repairFailureSignature(input: RepairFailureSignatureInput): string {
  const assertions = input.assertions
    .map(canonicalAssertion)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = JSON.stringify(
    canonicalValue({
      version: "tanren-repair-failure-signature.v2",
      contractId: input.contractId,
      contractHash: input.contractHash,
      classification: input.classification,
      assertions,
    }),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
