import {
  DeliveryCompletedPayload,
  DeliveryDegradedPayload,
  DeliveryDemoStimulusAbortedPayload,
  DeliveryDemoStimulusStartedPayload,
} from "./deliveryDag.js";
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
  // in-17 durable post-merge delivery DAG (release activation after the authorized land).
  "delivery.completed": DeliveryCompletedPayload,
  "delivery.degraded": DeliveryDegradedPayload,
  "delivery.demo_stimulus_started": DeliveryDemoStimulusStartedPayload,
  "delivery.demo_stimulus_aborted": DeliveryDemoStimulusAbortedPayload,
} as const;
