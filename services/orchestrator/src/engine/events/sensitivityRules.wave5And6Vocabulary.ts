import type { SensitivityRule } from "./sensitivity.js";
import { wave5VocabularySensitivityRules } from "./sensitivityRules.wave5Vocabulary.js";
import { wave6VocabularySensitivityRules } from "./sensitivityRules.wave6Vocabulary.js";

// Keep the root registry below the 500-line source-file limit while making both
// serialized barrier vocabularies visible to the one registered rule list.
export const wave5And6VocabularySensitivityRules: SensitivityRule[] = [
  ...wave5VocabularySensitivityRules,
  ...wave6VocabularySensitivityRules,
];
