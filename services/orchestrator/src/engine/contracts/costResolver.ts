export type CostSource = "provider_direct" | "ccusage" | "codexbar" | "opportunity_computed";
export type PricingMode = "per_token" | "opportunity_cost" | "subscription_window";

export interface CostResolutionInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface CostResolution {
  costUsd: string;
  pricingMode: PricingMode;
  costSource: CostSource;
  raw: Record<string, unknown>;
}

export interface CostResolver {
  resolve(input: CostResolutionInput): Promise<CostResolution>;
}

export class FakeCostResolver implements CostResolver {
  async resolve(input: CostResolutionInput): Promise<CostResolution> {
    return {
      costUsd: "0",
      pricingMode: "opportunity_cost",
      costSource: "opportunity_computed",
      raw: { provider: input.provider, model: input.model }
    };
  }
}
