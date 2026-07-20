import { z } from "zod";
import { AUTHORING_ATTEMPT_BODY_PREVIEW_MAX } from "../../contracts/authoringKernel.js";

// Mission-complete W1-A: frozen integration.author.* lifecycle facts for IN-7.
// Canonical production registry forms — re-authored from the freeze / PREP shapes.
// Do not import prep/integrationAuthorEventPayloads drafts into EventRegistry.

const MissionNodeId = z.literal("in-7");
const UnitId = z.string().min(1).max(256);
const CanonicalSignature = z.string().min(1).max(256);
const Diagnostic = z.string().max(2_000);
const FailureReason = z.string().min(1).max(2_000);

export const IntegrationAuthorStartedPayload = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
  })
  .strict();

export const IntegrationAuthorAttemptPayload = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
    attempt: z.number().int().min(1),
    bodyPreview: z.string().max(AUTHORING_ATTEMPT_BODY_PREVIEW_MAX),
    canonicalSignature: CanonicalSignature,
    rejection: Diagnostic,
    decision: z.enum(["continue", "converged", "halted_fixed_point"]),
  })
  .strict();

export const IntegrationAuthorSucceededPayload = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
    attempts: z.number().int().min(1),
  })
  .strict();

export const IntegrationAuthorFailedPayload = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
    reason: FailureReason,
    attempts: z.number().int().min(0),
  })
  .strict();

export const w1aEventRegistry = {
  "integration.author.started": IntegrationAuthorStartedPayload,
  "integration.author.attempt": IntegrationAuthorAttemptPayload,
  "integration.author.succeeded": IntegrationAuthorSucceededPayload,
  "integration.author.failed": IntegrationAuthorFailedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
