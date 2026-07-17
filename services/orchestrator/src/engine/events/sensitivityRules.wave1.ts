import type { SensitivityRule } from "./sensitivity.js";
import { integrationVocabularySensitivityRules } from "./sensitivityRules.integrationVocabulary.js";
import { runtimeVocabularySensitivityRules } from "./sensitivityRules.runtimeVocabulary.js";

// WAVE-1 sensitivity FREEZE aggregate: the integration (in-3) + runtime (rv-25)
// rule sets combined into ONE array so the central sensitivity table pulls the
// whole wave as a single dependency (keeping sensitivityRules.ts under the import
// cap). Pure composition — no new paths or tags beyond the two source modules.
export const wave1SensitivityRules: SensitivityRule[] = [
  ...integrationVocabularySensitivityRules,
  ...runtimeVocabularySensitivityRules,
];
