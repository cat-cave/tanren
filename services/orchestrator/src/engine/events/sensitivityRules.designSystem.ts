import type { SensitivityRule } from "./sensitivity.js";

// Sensitivity tags for the ds-0 DESIGN-SYSTEM event vocabulary (mission design
// bucket §7). Every frozen payload carries only stable IDs, content digests,
// counts, and closed-vocab classifications (no rendered bytes, screenshots,
// secrets, or provider bodies), so every reachable path is `public`. A "[]"
// suffix tags every element of an array path.

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const designSystemSensitivityRules: SensitivityRule[] = [
  ...publicRules("designSystem.curation.started", [
    "curationId",
    "contractVersion",
    "contractDigest",
    "targetProfiles",
    "targetProfiles[]",
    "plainBaseReleaseId",
    "expectedBehaviorRefCount",
    "expectedPersonaRefCount",
  ]),
  ...publicRules("designSystem.base.composed", [
    "curationId",
    "plainArtifactDigest",
    "catalogBuildDigest",
    "tokenResolutionDigest",
  ]),
  ...publicRules("designSystem.fragment.missing", ["curationId", "capability", "dependencyPath", "dependencyPath[]"]),
  ...publicRules("designFragment.authoring.started", ["fragmentAuthoringRunId", "fragmentKind", "fragmentLabel"]),
  ...publicRules("designFragment.authoring.attempt", [
    "fragmentAuthoringRunId",
    "attempt",
    "workspaceChangeId",
    "rejectionSignature",
  ]),
  ...publicRules("designFragment.authoring.succeeded", [
    "fragmentAuthoringRunId",
    "fragmentReleaseId",
    "fragmentDigest",
    "fragmentVersion",
  ]),
  ...publicRules("designFragment.authoring.failed", ["fragmentAuthoringRunId", "attempts", "reason"]),
  ...publicRules("designSystem.candidate.composed", [
    "curationId",
    "candidateReleaseId",
    "candidateArtifactId",
    "fragmentGraphDigest",
    "plainToPolishedDiffDigest",
  ]),
  ...publicRules("designSystem.artifact.validated", [
    "releaseId",
    "artifactId",
    "artifactDigest",
    "validationRunId",
    "expectedMatrixDigest",
  ]),
  ...publicRules("designRender.scenario.recorded", [
    "validationRunId",
    "evidenceId",
    "artifactDigest",
    "scenarioKey",
    "personaRef",
    "behaviorRef",
    "themeContext",
    "viewport",
    "screenshotDigest",
    "verdict",
  ]),
  ...publicRules("designSystem.release.published", [
    "releaseId",
    "designSystemId",
    "version",
    "manifestDigest",
    "signature",
    "validationRunId",
    "publishedBy",
  ]),
  ...publicRules("designSystem.proof.reused", ["validationRunId", "reusedProofId", "proofReuseKey", "releaseId"]),
  ...publicRules("designSystem.regression.bisected", [
    "groupId",
    "failingMatrixCell",
    "batchId",
    "testedPrefixCount",
    "culpritReleaseId",
  ]),
  ...publicRules("designSystem.binding.updated", [
    "projectId",
    "bindingId",
    "oldReleaseId",
    "newReleaseId",
    "pinMode",
    "generatedUpgradeSpecIds",
    "generatedUpgradeSpecIds[]",
  ]),
];
