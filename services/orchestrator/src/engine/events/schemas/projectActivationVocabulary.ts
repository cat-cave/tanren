import { z } from "zod";

// Project activation is blocked only by REQUIRED integration capabilities. This
// event records the gate's structured, secret-free reason while the project
// deliberately remains in the durable `deriving` lifecycle state.

const Id = z.string().min(1).max(256);
const Criticality = z.string().min(1).max(128);

const UnreadyCapability = z
  .object({
    requirementId: Id,
    capability: z.string().min(1).max(128),
    criticality: Criticality,
    status: z.string().min(1).max(128),
    waitReason: z.string().min(1).max(512).nullable(),
  })
  .strict();

const MaterializationGap = z
  .object({
    requirementId: Id,
    capability: z.string().min(1).max(128),
    criticality: Criticality,
  })
  .strict();

export const ProjectActivationReadinessBlockedPayload = z
  .object({
    reason: z
      .object({
        unreadyCapabilities: z.array(UnreadyCapability).max(256),
        materializationGaps: z.array(MaterializationGap).max(256),
      })
      .strict(),
  })
  .strict();

export const projectActivationVocabularyRegistry = {
  "project.activation.readiness_blocked": ProjectActivationReadinessBlockedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
