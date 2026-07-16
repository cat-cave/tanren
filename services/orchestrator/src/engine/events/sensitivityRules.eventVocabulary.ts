import type { SensitivityRule } from "./sensitivity.js";
import { eventVocabularyW0SensitivityRules } from "./sensitivityRules.eventVocabularyW0.js";
import { eventVocabularyW1aIntegrationAuthorSensitivityRules } from "./sensitivityRules.eventVocabularyW1aIntegrationAuthor.js";

export { benchmarkSensitivityRules } from "./sensitivityRules.benchmark.js";

export const eventVocabularySensitivityRules: SensitivityRule[] = [
  ...eventVocabularyW0SensitivityRules,
  ...eventVocabularyW1aIntegrationAuthorSensitivityRules,
];
