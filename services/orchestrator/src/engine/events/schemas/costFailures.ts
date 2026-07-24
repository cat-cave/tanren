import { z } from "zod";

// Loud cost-observability failures remain separate from the substrate schemas so
// that both domains retain room for future fail-closed payload additions.
export const CostProviderCaptureFailedPayload = z
  .object({
    generationId: z.string(),
    detail: z.string(),
    reason: z.string(),
  })
  .strict();

export const CostNotionalUnpricedPayload = z
  .object({
    provider: z.string(),
    model: z.string(),
    cli: z.string(),
    taskId: z.string(),
    reason: z.string(),
  })
  .strict();

export const CostReconcileFailedPayload = z
  .object({
    basis: z.enum(["ccusage", "credits"]),
    totalCostUsd: z.number(),
    reason: z.enum(["no_rows", "zero_token_denominator"]),
    reasonText: z.string(),
  })
  .strict();
