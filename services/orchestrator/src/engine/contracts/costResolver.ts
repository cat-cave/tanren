// CostResolver contract. Mirrors the cost model in engine/costs: token
// accounting by disjoint type is mandatory; the dollar figure is best-effort
// (null when no reliable basis exists).
export type CostBasis = "ccusage" | "provider_pricing" | "unknown";
export type BillingMode = "per_token" | "subscription" | "self_hosted";

export interface CostResolutionInput {
  provider: string;
  model: string;
  // Disjoint token-type buckets (see providers/types.ts TokenUsage).
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CostResolution {
  // null when cost is genuinely unknown (subscription/self-hosted/unpriced).
  costUsd: string | null;
  billingMode: BillingMode;
  costBasis: CostBasis;
  raw: Record<string, unknown>;
}

export interface CostResolver {
  resolve(input: CostResolutionInput): Promise<CostResolution>;
}

export class FakeCostResolver implements CostResolver {
  async resolve(input: CostResolutionInput): Promise<CostResolution> {
    return {
      costUsd: null,
      billingMode: "self_hosted",
      costBasis: "unknown",
      raw: { provider: input.provider, model: input.model },
    };
  }
}
