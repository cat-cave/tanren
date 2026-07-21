import type { SensitivityRule } from "./sensitivity.js";
import { benchmarkSensitivityRules } from "./sensitivityRules.benchmark.js";
import { eagerBeamSensitivityRules } from "./sensitivityRules.eagerBeam.js";
import {
  designSystemSensitivityRules,
  eventVocabularyW0SensitivityRules,
  governanceVocabularySensitivityRules,
  wave1SensitivityRules,
  wave3VocabularySensitivityRules,
  wave4VocabularySensitivityRules,
  wave5And6AndResolutionClusterVocabularySensitivityRules,
} from "./sensitivityRules.eventVocabularyW0.js";
import { eventVocabularyW1aIntegrationAuthorSensitivityRules } from "./sensitivityRules.eventVocabularyW1aIntegrationAuthor.js";
import { projectActivationVocabularySensitivityRules } from "./sensitivityRules.projectActivationVocabulary.js";
import { queuePolicySensitivityRules } from "./sensitivityRules.queuePolicy.js";

// Single fan-in aggregation point for the mission-complete event-vocabulary
// sensitivity rules. Re-exports the sibling wave rules (so `sensitivityRules.ts`
// imports them all from ONE source, honoring the import-slot ceiling) plus the
// combined W0 + W1-A leaf-path rules. The W0 module is referenced exactly once
// (imported here, re-exported locally) so this file owns a single W0 import slot.
export {
  benchmarkSensitivityRules,
  designSystemSensitivityRules,
  governanceVocabularySensitivityRules,
  wave1SensitivityRules,
  wave3VocabularySensitivityRules,
  wave4VocabularySensitivityRules,
  wave5And6AndResolutionClusterVocabularySensitivityRules,
};

export const eventVocabularySensitivityRules: SensitivityRule[] = [
  ...[
    "nodeId",
    "recordedOnNodeId",
    "memberKey",
    "proofReuseKey",
    "verdict",
    "gateProofBundleId",
    "proofBundleDigest",
    "quarantineVersion",
    "baseSha",
    "headSha",
    "sectionDigests[]",
  ].map((path) => ({ eventName: "integration.proof.reused", path, tag: "public" as const })),
  ...[
    "outcomeId",
    "decision",
    "result",
    "gateProofBundleId",
    "proofBundleDigest",
    "proofRoot",
    "quarantineVersion",
    "baseSha",
    "headSha",
    "memberSetHash",
    "mainSha",
  ].map((path) => ({ eventName: "merge.runtime_outcome.recorded", path, tag: "public" as const })),
  ...eventVocabularyW0SensitivityRules,
  ...eventVocabularyW1aIntegrationAuthorSensitivityRules,
  ...eagerBeamSensitivityRules,
  ...projectActivationVocabularySensitivityRules,
  ...queuePolicySensitivityRules,
];
