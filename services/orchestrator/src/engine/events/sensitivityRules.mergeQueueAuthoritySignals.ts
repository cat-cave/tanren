import type { SensitivityRule } from "./sensitivity.js";

const EVENT_NAMES = ["merge.signal.classified", "merge.member.policy_blocked"] as const;
const PUBLIC_PATHS = [
  "missionNodeId",
  "evaluationId",
  "groupId",
  "signalVersion",
  "memberIds",
  "memberIds[]",
  "findingIds",
  "findingIds[]",
  "classification",
  "reasonCode",
  "retryability",
  "wakeKey",
  "disposition",
] as const;

/**
 * The mq-1 payload intentionally contains only opaque identifiers and closed
 * outcomes. Finding prose and the infrastructure source key never cross into
 * either event, so every declared payload path is project-visible.
 */
export const mergeQueueAuthoritySignalSensitivityRules: SensitivityRule[] = EVENT_NAMES.flatMap((eventName) =>
  PUBLIC_PATHS.map((path) => ({ eventName, path, tag: "public" as const })),
);
