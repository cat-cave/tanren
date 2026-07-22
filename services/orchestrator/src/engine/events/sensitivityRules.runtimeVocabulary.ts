import type { SensitivityRule } from "./sensitivity.js";

// Sensitivity tags for the WAVE-1 runtime behavior-proof vocabulary (rv-25).
// Every frozen payload carries only stable IDs, hashes, counts, and
// classifications (no rendered bytes, secrets, or provider bodies), so every
// reachable path is `public`.

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const runtimeVocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("behavior.contract.compilation_started", ["behaviorRevisionId", "behaviorRevisionHash"]),
  ...publicRules("behavior.contract.compiled", [
    "behaviorRevisionId",
    "behaviorRevisionHash",
    "planHash",
    "assertionCount",
    "surfaceKinds",
    "surfaceKinds[]",
  ]),
  ...publicRules("behavior.contract.rejected", ["behaviorRevisionId", "behaviorRevisionHash", "reason"]),
  ...publicRules("behavior.fragment.missing", ["behaviorRevisionId", "capability"]),
  ...publicRules("behavior.fragment.authoring_started", ["behaviorRevisionId", "capability", "fragmentId"]),
  ...publicRules("behavior.fragment.validated", [
    "behaviorRevisionId",
    "capability",
    "fragmentId",
    "fragmentVersion",
    "negativeControlPassed",
  ]),
  ...publicRules("behavior.verification.started", ["behaviorRevisionId", "integrationNodeId", "artifactDigest"]),
  ...publicRules("behavior.shard.started", ["behaviorRevisionId", "shardId", "matrixKey"]),
  ...publicRules("behavior.attempt.started", ["behaviorRevisionId", "shardId", "attempt"]),
  ...publicRules("behavior.action.observed", ["behaviorRevisionId", "shardId", "actionId", "surface"]),
  ...publicRules("behavior.assertion.observed", ["behaviorRevisionId", "shardId", "assertionId", "satisfied"]),
  ...publicRules("behavior.effect.observed", [
    "behaviorRevisionId",
    "shardId",
    "correlationId",
    "providerReceiptId",
    "deliveryRunId",
    "causeOrdinal",
    "occurrenceCount",
  ]),
  ...publicRules("design.render.captured", [
    "renderId",
    "artifactDigest",
    "scenarioKey",
    "designContractVersion",
    "a11yViolationCount",
  ]),
  ...publicRules("design.render.verdict_recorded", [
    "renderVerificationId",
    "artifactDigest",
    "pixelOutcome",
    "semanticOutcome",
    "a11yOutcome",
    "contractDigest",
    "contractClauseRefs",
    "contractClauseRefs[]",
  ]),
  ...publicRules("behavior.verdict.recorded", [
    "behaviorRevisionId",
    "verdictId",
    "outcome",
    "executedAssertionCount",
    "flakeState",
  ]),
  ...publicRules("behavior.verification.completed", [
    "integrationNodeId",
    "requiredVerdictCount",
    "passedVerdictCount",
  ]),
  ...publicRules("gate.behavior_proof.bound", [
    "integrationNodeId",
    "gateProofBundleDigest",
    "requiredBehaviorRevisionCount",
    "planSetHash",
  ]),
  ...publicRules("integration.proof.recorded", [
    "nodeId",
    "memberKey",
    "proofReuseKey",
    "verdict",
    "runtimeBehaviorContextHash",
    "requiredBehaviorRevisionCount",
  ]),
  ...publicRules("merge.batch.behavior_failed", ["groupId", "behaviorRevisionId", "verdictId", "outcome"]),
  ...publicRules("merge.batch.culprit_set_identified", ["groupId", "culpritMemberIds", "culpritMemberIds[]"]),
  ...publicRules("behavior.respec.requested", ["behaviorRevisionId", "reason"]),
  ...publicRules("post_merge.behavior.verified", ["behaviorRevisionId", "verdictId", "deploySha", "artifactDigest"]),
  ...publicRules("post_merge.behavior.failed", ["behaviorRevisionId", "verdictId", "deploySha", "outcome"]),
  ...publicRules("deployment.promoted", ["deploymentId", "artifactDigest", "deploySha", "environment"]),
  ...publicRules("deployment.rolled_back", ["deploymentId", "artifactDigest", "reason"]),
];
