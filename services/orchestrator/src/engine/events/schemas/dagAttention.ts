import { z } from "zod";

export { DagSpecNeedsAttentionPayload } from "./dagNeedsAttention.js";

// dag.spec.attention_resolved records the operator's explicit resolution of a
// prior escalation; it is kept with the escalation schema as one domain group.
export const DagSpecAttentionResolvedPayload = z
  .object({
    specId: z.string(),
    fromSource: z.enum(["strand", "merge_conflict"]),
    resolvedBy: z.string(),
  })
  .strict();
export type DagSpecAttentionResolvedPayload = z.infer<typeof DagSpecAttentionResolvedPayload>;
