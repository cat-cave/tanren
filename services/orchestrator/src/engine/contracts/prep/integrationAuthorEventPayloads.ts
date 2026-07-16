import { z } from "zod";
import { AUTHORING_ATTEMPT_BODY_PREVIEW_MAX } from "../authoringKernel.js";
import type { SensitivityRule } from "../../events/sensitivity.js";
import type { Severity } from "../../notifications/schemas.js";

// PREP ONLY: these names are prospective and unfrozen. This module is not
// imported by EventRegistry, eventDefaultSeverity, or the sensitivity runtime.
export const INTEGRATION_AUTHOR_EVENT_NAMESPACE_STATUS = "prospective_unfrozen" as const;
export const INTEGRATION_AUTHOR_MISSION_NODE_ID = "in-7" as const;

export const PROSPECTIVE_INTEGRATION_AUTHOR_EVENT_NAMES = [
  "integration.author.started",
  "integration.author.attempt",
  "integration.author.succeeded",
  "integration.author.failed",
] as const;

export type ProspectiveIntegrationAuthorEventName = (typeof PROSPECTIVE_INTEGRATION_AUTHOR_EVENT_NAMES)[number];

const MissionNodeId = z.literal(INTEGRATION_AUTHOR_MISSION_NODE_ID);
const UnitId = z.string().min(1).max(256);
const CanonicalSignature = z.string().min(1).max(256);
const Diagnostic = z.string().max(2_000);
const FailureReason = z.string().min(1).max(2_000);

export const IntegrationAuthorStartedPayloadDraft = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
  })
  .strict();

export const IntegrationAuthorAttemptPayloadDraft = z
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

export const IntegrationAuthorSucceededPayloadDraft = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
    attempts: z.number().int().min(1),
  })
  .strict();

export const IntegrationAuthorFailedPayloadDraft = z
  .object({
    missionNodeId: MissionNodeId,
    unitId: UnitId,
    reason: FailureReason,
    attempts: z.number().int().min(0),
  })
  .strict();

/** Unregistered schema drafts. Do not spread this map into EventRegistry. */
export const integrationAuthorEventPayloadDrafts = {
  "integration.author.started": IntegrationAuthorStartedPayloadDraft,
  "integration.author.attempt": IntegrationAuthorAttemptPayloadDraft,
  "integration.author.succeeded": IntegrationAuthorSucceededPayloadDraft,
  "integration.author.failed": IntegrationAuthorFailedPayloadDraft,
} as const;

export type IntegrationAuthorEventPayloadDraftByName = {
  readonly [Name in ProspectiveIntegrationAuthorEventName]: z.infer<(typeof integrationAuthorEventPayloadDrafts)[Name]>;
};

export const integrationAuthorEventDefaultSeverityDraft = {
  "integration.author.started": "ok",
  "integration.author.attempt": "info",
  "integration.author.succeeded": "ok",
  "integration.author.failed": "fail",
} as const satisfies Readonly<Record<ProspectiveIntegrationAuthorEventName, Severity>>;

/** Complete leaf paths for the flat strict payload drafts; all are public. */
export const integrationAuthorEventSensitivityDrafts = [
  ...publicPaths("integration.author.started", ["missionNodeId", "unitId"]),
  ...publicPaths("integration.author.attempt", [
    "missionNodeId",
    "unitId",
    "attempt",
    "bodyPreview",
    "canonicalSignature",
    "rejection",
    "decision",
  ]),
  ...publicPaths("integration.author.succeeded", ["missionNodeId", "unitId", "attempts"]),
  ...publicPaths("integration.author.failed", ["missionNodeId", "unitId", "reason", "attempts"]),
] as const satisfies ReadonlyArray<SensitivityRule>;

function publicPaths(
  eventName: ProspectiveIntegrationAuthorEventName,
  paths: readonly string[],
): ReadonlyArray<SensitivityRule> {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}
