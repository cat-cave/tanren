import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

// Wave-6 payloads are identifiers, digests, classifications, and counts only.
// Existing behavior.effect.observed and integration.proof.invalidated rules stay
// in their original vocabularies, which retain their already-frozen contracts.
export const wave6VocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("fixture.lease.acquired", ["projectId", "leaseId", "kind", "resourceRef", "correlationNamespace"]),
  ...publicRules("fixture.lease.released", ["projectId", "leaseId", "cleanupEvidenceHash"]),
  ...publicRules("fixture.lease.expired", ["projectId", "leaseId", "kind"]),
  ...publicRules("fixture.lease.cleanup_failed", ["projectId", "leaseId", "cleanupEvidenceHash"]),
  ...publicRules("behavior.effect.missing", [
    "projectId",
    "observationId",
    "triggerIdHash",
    "observer",
    "provider",
    "occurrenceCount",
  ]),
  ...publicRules("behavior.effect.duplicate", [
    "projectId",
    "observationId",
    "triggerIdHash",
    "providerObjectHash",
    "observer",
    "provider",
    "occurrenceCount",
  ]),
  ...publicRules("observer.watermark.advanced", ["projectId", "observer", "watermarkHash"]),
  ...publicRules("observer.inconclusive_external", [
    "projectId",
    "observationId",
    "observer",
    "provider",
    "cursorHash",
  ]),
  ...publicRules("integration.proof_unit.recorded", [
    "projectId",
    "proofUnitId",
    "kind",
    "subjectId",
    "inputHash",
    "artifactHash",
    "quarantineEpoch",
  ]),
  ...publicRules("integration.proof_unit.reused", [
    "projectId",
    "proofUnitId",
    "sourceNodeId",
    "inputHash",
    "quarantineEpoch",
  ]),
  ...publicRules("integration.proof_root.composed", [
    "projectId",
    "integrationNodeId",
    "proofRoot",
    "proofUnitIds",
    "proofUnitIds[]",
  ]),
  ...publicRules("repository.visibility.observed", [
    "projectId",
    "observationId",
    "observedVisibility",
    "forgeRef",
    "sha",
  ]),
  ...publicRules("repository.visibility.mismatch", [
    "projectId",
    "observationId",
    "expectedVisibility",
    "observedVisibility",
    "forgeRef",
    "sha",
  ]),
  ...publicRules("governance.visibility.enforced", ["projectId", "observationId", "visibility"]),
];
