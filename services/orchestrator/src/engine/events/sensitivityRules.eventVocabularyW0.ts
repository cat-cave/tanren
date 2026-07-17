import type { SensitivityRule } from "./sensitivity.js";

export { benchmarkSensitivityRules } from "./sensitivityRules.benchmark.js";
export { wave1SensitivityRules } from "./sensitivityRules.wave1.js";
export { governanceVocabularySensitivityRules } from "./sensitivityRules.governanceVocabulary.js";
export { designSystemSensitivityRules } from "./sensitivityRules.designSystem.js";
export { wave3VocabularySensitivityRules } from "./sensitivityRules.wave3Vocabulary.js";
export { wave4VocabularySensitivityRules } from "./sensitivityRules.wave4Vocabulary.js";
export { wave5And6AndResolutionClusterVocabularySensitivityRules } from "./sensitivityRules.wave5And6AndResolutionClusterVocabulary.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

const mergeSignalPaths = [
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

export const eventVocabularyW0SensitivityRules: SensitivityRule[] = [
  ...publicRules("integration.requirement.validated", [
    "missionNodeId",
    "requirementDigest",
    "artifact.digest",
    "artifact.byteSize",
    "artifact.mediaType",
    "capability",
    "plane",
    "direction",
    "criticality",
  ]),
  ...publicRules("behavior.coverage.selection_analyzed", [
    "version",
    "analysisId",
    "mode",
    "changedTargets",
    "changedTargets[].kind",
    "changedTargets[].targetRef",
    "unknownTargets",
    "unknownTargets[].kind",
    "unknownTargets[].targetRef",
    "selected",
    "selected[].behaviorRevisionId",
    "selected[].reasons",
    "selected[].reasons[].kind",
    "selected[].reasons[].edgeId",
    "selected[].reasons[].target.kind",
    "selected[].reasons[].target.targetRef",
    "selected[].reasons[].dependencyBehaviorRevisionId",
    "selected[].reasons[].targetRef",
    "excluded",
    "excluded[].behaviorRevisionId",
    "excluded[].reason",
    "excluded[].inspectedEdgeIds",
    "excluded[].inspectedEdgeIds[]",
  ]),
  ...publicRules("governance.audit_posture.updated", [
    "actorUserId",
    "previous.blockReviewAt",
    "previous.p2p3Handling",
    "previous.autonomousRemediation",
    "current.blockReviewAt",
    "current.p2p3Handling",
    "current.autonomousRemediation",
  ]),
  ...publicRules("review.simulated_intent", [
    "headSha",
    "state",
    "event",
    "body",
    "message",
    "reviewerLogin",
    "marker",
  ]),
  ...publicRules("merge.signal.classified", mergeSignalPaths),
  ...publicRules("merge.member.policy_blocked", mergeSignalPaths),
];
