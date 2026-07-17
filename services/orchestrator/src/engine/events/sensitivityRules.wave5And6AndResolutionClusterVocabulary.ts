import type { SensitivityRule } from "./sensitivity.js";
import { resolutionClusterVocabularySensitivityRules } from "./sensitivityRules.resolutionClusterVocabulary.js";
import { wave5And6VocabularySensitivityRules } from "./sensitivityRules.wave5And6Vocabulary.js";

// Keep the root registry below the source-file cap while extending the frozen
// Wave-5/Wave-6 vocabulary with the back-half resolution cluster.
export const wave5And6AndResolutionClusterVocabularySensitivityRules: SensitivityRule[] = [
  ...wave5And6VocabularySensitivityRules,
  ...resolutionClusterVocabularySensitivityRules,
];
