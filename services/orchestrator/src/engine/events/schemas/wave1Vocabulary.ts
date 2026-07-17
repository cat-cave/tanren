import type { z } from "zod";
import { integrationVocabularyRegistry } from "./integrationVocabulary.js";
import { runtimeVocabularyRegistry } from "./runtimeVocabulary.js";

// WAVE-1 mission-complete event-vocabulary FREEZE aggregate: the in-3 integration
// lifecycle vocabulary + the rv-25 runtime behavior-proof vocabulary combined into
// ONE registry so the central EventRegistry pulls the whole wave as a single
// dependency (keeping registry.ts under the import/line caps). Pure composition —
// no new names, severities, or payloads beyond the two source modules.
export const wave1EventRegistry = {
  ...integrationVocabularyRegistry,
  ...runtimeVocabularyRegistry,
} as const satisfies Record<string, z.ZodTypeAny>;
