import { z } from "zod";

const Id = z.string().min(1).max(256);
const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const SymptomContractAuthoredPayload = z
  .object({
    projectId: Id,
    issueLoopId: Id,
    contractId: Id,
    schemaVersion: z.number().int().min(1),
    canonicalHash: Sha256Digest,
    sourceRevision: Id.optional(),
    authorTaskId: Id.optional(),
    baselineRequired: z.boolean(),
  })
  .strict();

export const SymptomContractValidatedPayload = z
  .object({
    projectId: Id,
    issueLoopId: Id,
    contractId: Id,
    canonicalHash: Sha256Digest,
    validationTaskId: Id.optional(),
  })
  .strict();

export const SymptomContractSupersededPayload = z
  .object({
    projectId: Id,
    issueLoopId: Id,
    contractId: Id,
    supersededByContractId: Id,
  })
  .strict();

export const SymptomContractAuthoringFailedPayload = z
  .object({
    projectId: Id,
    issueLoopId: Id,
    authorTaskId: Id.optional(),
    failureCode: z.enum(["invalid_source", "unsupported_contract", "validation_failed", "provider_failure", "unknown"]),
  })
  .strict();

export const symptomContractEventRegistry = {
  "symptom.contract.authored": SymptomContractAuthoredPayload,
  "symptom.contract.validated": SymptomContractValidatedPayload,
  "symptom.contract.superseded": SymptomContractSupersededPayload,
  "symptom.contract.authoring_failed": SymptomContractAuthoringFailedPayload,
} as const;
