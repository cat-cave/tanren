import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const wave5VocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("governance.binding.activated", [
    "projectId",
    "bindingId",
    "tierId",
    "policyRevisionId",
    "effectivePolicyHash",
  ]),
  ...publicRules("governance.effective_policy.recorded", [
    "projectId",
    "snapshotId",
    "bindingId",
    "tierId",
    "policyRevisionId",
    "effectivePolicyHash",
    "subjectKind",
    "subjectId",
    "inputsDigest",
  ]),
  ...publicRules("governance.binding.superseded", ["projectId", "bindingId", "supersededByBindingId", "tierId"]),
  ...publicRules("integration.node.materialized", [
    "projectId",
    "integrationNodeId",
    "memberKey",
    "baseSha",
    "headSha",
    "treeHash",
  ]),
  ...publicRules("integration.node.materialization_failed", [
    "projectId",
    "memberKey",
    "baseSha",
    "failureCode",
    "diagnosticsDigest",
  ]),
  ...publicRules("design.artifact.published", ["projectId", "artifactId", "releaseId", "artifactDigest"]),
  ...publicRules("design.catalog.built", ["projectId", "catalogId", "catalogDigest", "artifactIds", "artifactIds[]"]),
  ...publicRules("design.export.produced", ["projectId", "artifactId", "exportId", "format", "outputDigest"]),
];
