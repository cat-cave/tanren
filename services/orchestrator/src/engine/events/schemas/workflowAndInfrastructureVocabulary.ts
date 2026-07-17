import { agentEventRegistry } from "./agentVocabulary.js";
import { infrastructureEventRegistry } from "./infrastructureVocabulary.js";
import { lifecycleEventRegistry } from "./lifecycleVocabulary.js";

export const workflowAndInfrastructureEventRegistry = {
  ...lifecycleEventRegistry,
  ...agentEventRegistry,
  ...infrastructureEventRegistry,
} as const;
