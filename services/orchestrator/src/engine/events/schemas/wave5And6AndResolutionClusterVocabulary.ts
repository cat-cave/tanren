import { resolutionClusterEventRegistry } from "./resolutionClusterVocabulary.js";
import { wave5And6EventRegistry } from "./wave5And6Vocabulary.js";

// Keep the root EventRegistry below the source-file cap while adding the
// serialized back-half cluster to the already-frozen Wave-5/Wave-6 group.
export const wave5And6AndResolutionClusterEventRegistry = {
  ...wave5And6EventRegistry,
  ...resolutionClusterEventRegistry,
} as const;
