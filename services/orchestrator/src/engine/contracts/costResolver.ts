// CostResolver contract. Mirrors the cost model in engine/costs: token
// accounting by disjoint type is mandatory; the dollar figure is best-effort
// (null when no reliable basis exists).
// 'provider_response' is the provider's OWN authoritative per-call charge
// (OpenRouter's `usage.cost`) — the REAL deduction, no markup; it OUTRANKS every
// estimate. 'unattributed' (BUDGET-SAFETY C1): an UNRECOGNIZED credential ref
// whose cost could not be priced — recorded NULL-dollar but FLAGGED (not silent
// $0) so the budget gate fails closed. 'credits' is the prepaid-credit drawdown
// basis. All are real DB-persisted values, so every read-side consumer must
// accept them.
export type CostBasis = "ccusage" | "provider_response" | "credits" | "unknown" | "unattributed";
export type BillingMode = "per_token" | "subscription" | "self_hosted" | "unattributed";

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
