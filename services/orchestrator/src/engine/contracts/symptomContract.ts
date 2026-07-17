import { createHash } from "node:crypto";
import { z } from "zod";

const Id = z.string().min(1).max(256);

export const SYMPTOM_CONTRACT_PROOF_POLICIES = [
  "active_causal",
  "active_plus_soak",
  "observational",
  "attested",
] as const;

const JsonObject = z.record(z.string(), z.unknown());
const ProofPolicy = z.enum(SYMPTOM_CONTRACT_PROOF_POLICIES);

/** The v1 executable symptom identity persisted by the bh-4 store. */
export const SymptomContractV1Schema = z
  .object({
    version: z.literal(1),
    issueLoopId: Id,
    target: JsonObject,
    expectedFailingObservation: JsonObject,
    expectedCorrectedObservation: JsonObject,
    proofPolicy: ProofPolicy,
    sourceRevision: Id.nullable(),
    baselineRequired: z.boolean(),
  })
  .strict();

export type SymptomContractV1 = z.infer<typeof SymptomContractV1Schema>;
export type SymptomContractProofPolicy = (typeof SYMPTOM_CONTRACT_PROOF_POLICIES)[number];

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

/** Canonical JSON bytes used for the immutable contract identity. */
export function canonicalSymptomContractBytes(contract: SymptomContractV1): Uint8Array {
  const json = JSON.stringify(canonicalValue(contract));
  if (json === undefined) throw new Error("symptom contract canonicalization produced no JSON value");
  return new TextEncoder().encode(json);
}

/** Stable content identity; callers cannot supply or override this value. */
export function symptomContractHash(contract: SymptomContractV1): string {
  return `sha256:${createHash("sha256").update(canonicalSymptomContractBytes(contract)).digest("hex")}`;
}
