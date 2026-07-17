import type { z } from "zod";
import { mergeQueueWave3EventRegistry } from "./mergeQueue.js";
import { symptomContractEventRegistry } from "./symptomContract.js";

export const wave3EventRegistry = {
  ...symptomContractEventRegistry,
  ...mergeQueueWave3EventRegistry,
} as const satisfies Record<string, z.ZodTypeAny>;
