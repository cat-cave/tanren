import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const wave4VocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("symptom.baseline.started", ["projectId", "issueLoopId", "contractId", "verificationRunId"]),
  ...publicRules("symptom.baseline.observed", [
    "projectId",
    "issueLoopId",
    "contractId",
    "verificationRunId",
    "outcome",
    "evidenceArtifactIds",
    "evidenceArtifactIds[]",
  ]),
  ...publicRules("symptom.assertion.recorded", [
    "projectId",
    "issueLoopId",
    "verificationRunId",
    "assertionId",
    "expectedHash",
    "observedHash",
    "outcome",
    "timingMs",
  ]),
  ...publicRules("source.finding.recorded", [
    "projectId",
    "issueLoopId",
    "sourceFindingId",
    "sourceId",
    "providerRevision",
  ]),
  ...publicRules("source.sync.pending", ["issueLoopId", "outboxId", "sourceId", "operation", "payloadHash"]),
  ...publicRules("source.sync.verified", ["issueLoopId", "outboxId", "sourceId", "operation", "payloadHash"]),
  ...publicRules("source.sync.externally_closed_unverified", [
    "issueLoopId",
    "outboxId",
    "sourceId",
    "observedRevision",
  ]),
  ...publicRules("merge.group.formed", [
    "projectId",
    "groupId",
    "partitionId",
    "baseSha",
    "memberKeys",
    "memberKeys[]",
    "policyHash",
  ]),
  ...publicRules("merge.land_group.completed", [
    "projectId",
    "landGroupId",
    "decisionId",
    "expectedMainSha",
    "authorizedSha",
    "mainSha",
    "memberKeys",
    "memberKeys[]",
  ]),
  ...publicRules("merge.train.artifact.sealed", [
    "projectId",
    "landGroupId",
    "authorityDecisionId",
    "integrationNodeId",
    "proofRoot",
    "bundleId",
    "bundleDigest",
    "bytesDigest",
    "signingKeyId",
    "contentHash",
  ]),
  ...publicRules("governance.tier.created", ["projectId", "tierId", "tierName", "preset", "canonicalHash"]),
  ...publicRules("governance.tier.activated", [
    "projectId",
    "tierId",
    "tierName",
    "policyBindingId",
    "effectivePolicyHash",
  ]),
];
