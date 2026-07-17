import { wave5EventRegistry } from "./wave5Vocabulary.js";
import { wave6EventRegistry } from "./wave6Vocabulary.js";

// Keep the root EventRegistry below the source-file cap while registering both
// serialized barrier vocabularies as one frozen group.
export const wave5And6EventRegistry = {
  ...wave5EventRegistry,
  ...wave6EventRegistry,
} as const;
