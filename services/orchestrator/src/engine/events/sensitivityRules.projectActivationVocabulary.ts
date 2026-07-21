import type { SensitivityRule } from "./sensitivity.js";

function publicRules(paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName: "project.activation.readiness_blocked", path, tag: "public" }));
}

export const projectActivationVocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules([
    "reason.unreadyCapabilities",
    "reason.unreadyCapabilities[].requirementId",
    "reason.unreadyCapabilities[].capability",
    "reason.unreadyCapabilities[].criticality",
    "reason.unreadyCapabilities[].status",
    "reason.unreadyCapabilities[].waitReason",
    "reason.materializationGaps",
    "reason.materializationGaps[].requirementId",
    "reason.materializationGaps[].capability",
    "reason.materializationGaps[].criticality",
  ]),
];
