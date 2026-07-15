import type { SensitivityRule } from "./sensitivity.js";

const EVENT_NAMES = ["merge.signal.classified", "merge.member.policy_blocked"] as const;
const PUBLIC_PATHS = [
  "missionNodeId",
  "evaluationId",
  "groupId",
  "memberIds",
  "memberIds[]",
  "findingIds",
  "findingIds[]",
  "signalVersion",
  "sourceEventId",
  "classification",
  "reasonCode",
  "retryability",
  "wakeKey",
  "repairRoute",
] as const;

/**
 * mq-1 events contain only opaque identities and closed-vocabulary outcomes. Raw
 * finding prose/provider evidence is deliberately excluded from their schemas.
 */
export const mergeQueueAuthoritySignalSensitivityRules: SensitivityRule[] = EVENT_NAMES.flatMap((eventName) =>
  PUBLIC_PATHS.map((path) => ({ eventName, path, tag: "public" as const })),
);
