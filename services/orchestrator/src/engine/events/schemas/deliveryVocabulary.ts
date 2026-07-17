import { deploymentEventRegistry } from "./deploymentVocabulary.js";
import { gateEventRegistry } from "./gateVocabulary.js";
import { githubEventRegistry } from "./githubVocabulary.js";
import { mergeQueueEventRegistry } from "./mergeQueueVocabulary.js";
import { notificationEventRegistry } from "./notificationVocabulary.js";
import { postMergeEventRegistry } from "./postMergeVocabulary.js";
import { reviewAndMergeEventRegistry } from "./reviewAndMergeVocabulary.js";

export const deliveryEventRegistry = {
  ...githubEventRegistry,
  ...gateEventRegistry,
  ...reviewAndMergeEventRegistry,
  ...mergeQueueEventRegistry,
  ...postMergeEventRegistry,
  ...notificationEventRegistry,
  ...deploymentEventRegistry,
} as const;
