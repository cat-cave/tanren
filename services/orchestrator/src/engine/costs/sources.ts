// Cost-attribution rules and the typed CostSource discriminated union (P2A-0011).
//
// Every completed Codex planner/writer/checker/auditor call must be attributed
// to exactly one of the three v0 cost models from PROJECT_BRIEF §4:
//
//   provider_direct      — token-billed API key (§4.1)
//   codexbar             — ChatGPT subscription consumed via Codex CLI (§4.3)
//   opportunity_computed — self-hosted GPU / fixed-fee endpoint (§4.2)
//
// The attribution rule consults the credential auth ref. If the ref does not
// match any rule the recorder throws CostUnattributableError; the task fails
// with failureKind="cost.unattributable" and the run halts. There is no
// silent fallback and no `unknown_source` row.
import { z } from "zod";

export const PricingMode = z.enum(["per_token", "subscription_window", "opportunity_cost"]);
export type PricingMode = z.infer<typeof PricingMode>;

export const RawUsage = z.record(z.string(), z.unknown());
export type RawUsage = z.infer<typeof RawUsage>;

// CostSource is the typed input to the CostRecorder. The orchestrator builds
// the matching variant from the auth ref (see resolveCostSource) and the
// per-call token usage.
export const CostSource = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("provider_direct"),
      pricingMode: z.literal("per_token"),
      provider: z.string(),
      inputCostPerMillion: z.number(),
      outputCostPerMillion: z.number(),
      cachedInputCostPerMillion: z.number().nullable(),
      rawUsage: RawUsage
    })
    .strict(),
  z
    .object({
      source: z.literal("codexbar"),
      pricingMode: z.literal("subscription_window"),
      provider: z.literal("openai"),
      subscriptionMonthlyFee: z.number(),
      observedMaxMonthlyTokens: z.number(),
      rawUsage: RawUsage
    })
    .strict(),
  z
    .object({
      source: z.literal("opportunity_computed"),
      pricingMode: z.literal("opportunity_cost"),
      provider: z.string(),
      hourlyOpportunityCostUsd: z.number(),
      runtimeSeconds: z.number(),
      rawUsage: RawUsage
    })
    .strict()
]);
export type CostSource = z.infer<typeof CostSource>;

export interface AttributionInput {
  cli: "codex" | "claude" | "opencode" | "fake";
  authRef: string;
  rawUsage: RawUsage;
  // For opportunity_computed we need the wall-clock runtime of the call.
  runtimeSeconds?: number;
  // For codexbar we need the (possibly already-refined) denominator pulled
  // from subscription_window_denominators by the caller.
  observedMaxMonthlyTokens?: number;
}

export class CostUnattributableError extends Error {
  readonly kind = "cost.unattributable" as const;
  constructor(
    readonly authRef: string,
    readonly reason: string,
    readonly cli: string,
    readonly attempted: ReadonlyArray<string>
  ) {
    super(`cost.unattributable: no rule matched cli=${cli} ref=${authRef} reason=${reason}`);
    this.name = "CostUnattributableError";
  }
}

// Defaults documented in docs/operator-guide/costs.md. The denominator is
// intentionally conservative on month one and refines from observed history
// (see CostRecorder.refineSubscriptionDenominator).
const codexbarSubscriptionMonthlyFeeUsd = 20;
const codexbarTheoreticalMaxMonthlyTokens = 50_000_000;

// Provider price tables. Pinned at known v0 list prices. Refining these is a
// separate concern from cost attribution; see docs/operator-guide/costs.md
// for the source-of-truth dates.
interface ProviderRate {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion: number | null;
}

const providerRateTable: Record<string, ProviderRate> = {
  openai: { inputCostPerMillion: 2.5, outputCostPerMillion: 10, cachedInputCostPerMillion: 1.25 },
  anthropic: { inputCostPerMillion: 3, outputCostPerMillion: 15, cachedInputCostPerMillion: 0.3 },
  openrouter: { inputCostPerMillion: 5, outputCostPerMillion: 15, cachedInputCostPerMillion: null }
};

export function providerRate(provider: string): ProviderRate | undefined {
  return providerRateTable[provider];
}

// Classification of a credential ref. Order matters: codexbar must win over
// provider_direct when the ref is a Codex ChatGPT subscription bundle so a
// ChatGPT-Pro operator is never charged at provider list prices.
type RefClassification =
  | { kind: "codexbar" }
  | { kind: "provider_direct"; provider: string }
  | { kind: "opportunity_computed"; provider: string }
  | { kind: "unattributable"; reason: string };

export function classifyAuthRef(authRef: string): RefClassification {
  if (authRef === "") {
    return { kind: "unattributable", reason: "empty auth ref" };
  }
  // Codex CLI ChatGPT-subscription bundles always live under credential/codex/
  // (see services/orchestrator/src/engine/credentials/codexAuth.ts). These
  // are subscription-window dollars, never per-token.
  if (authRef.startsWith("credential/codex/")) {
    return { kind: "codexbar" };
  }
  if (authRef.startsWith("credential/anthropic/")) {
    return { kind: "provider_direct", provider: "anthropic" };
  }
  if (authRef.startsWith("credential/openai-api/")) {
    return { kind: "provider_direct", provider: "openai" };
  }
  if (authRef.startsWith("credential/openrouter/")) {
    return { kind: "provider_direct", provider: "openrouter" };
  }
  if (authRef.startsWith("credential/self-hosted/")) {
    return { kind: "opportunity_computed", provider: refTailSegment(authRef) ?? "self-hosted" };
  }
  return { kind: "unattributable", reason: `no rule for ref prefix: ${authRef.split("/").slice(0, 2).join("/")}/` };
}

function refTailSegment(ref: string): string | undefined {
  const parts = ref.split("/").filter((part) => part !== "");
  return parts[parts.length - 1];
}

// resolveCostSource is the entry point. It either returns a fully-typed
// CostSource ready for the recorder to persist, or throws
// CostUnattributableError. Callers must NOT swallow the error.
export function resolveCostSource(input: AttributionInput): CostSource {
  const classification = classifyAuthRef(input.authRef);
  const attempted = ["provider_direct", "codexbar", "opportunity_computed"];
  if (classification.kind === "unattributable") {
    throw new CostUnattributableError(input.authRef, classification.reason, input.cli, attempted);
  }
  if (classification.kind === "codexbar") {
    return {
      source: "codexbar",
      pricingMode: "subscription_window",
      provider: "openai",
      subscriptionMonthlyFee: codexbarSubscriptionMonthlyFeeUsd,
      observedMaxMonthlyTokens: input.observedMaxMonthlyTokens ?? codexbarTheoreticalMaxMonthlyTokens,
      rawUsage: input.rawUsage
    };
  }
  if (classification.kind === "provider_direct") {
    const rate = providerRate(classification.provider);
    if (rate === undefined) {
      throw new CostUnattributableError(
        input.authRef,
        `provider ${classification.provider} has no rate entry`,
        input.cli,
        attempted
      );
    }
    return {
      source: "provider_direct",
      pricingMode: "per_token",
      provider: classification.provider,
      inputCostPerMillion: rate.inputCostPerMillion,
      outputCostPerMillion: rate.outputCostPerMillion,
      cachedInputCostPerMillion: rate.cachedInputCostPerMillion,
      rawUsage: input.rawUsage
    };
  }
  // opportunity_computed
  if (input.runtimeSeconds === undefined) {
    throw new CostUnattributableError(
      input.authRef,
      "opportunity_computed requires runtimeSeconds",
      input.cli,
      attempted
    );
  }
  // Default opportunity-cost figure for v0: $0.50/hour. Operators can
  // configure this per credential in P2A-0006 follow-ups; the recorder reads
  // the configured value when present, falling back to this default.
  return {
    source: "opportunity_computed",
    pricingMode: "opportunity_cost",
    provider: classification.provider,
    hourlyOpportunityCostUsd: 0.5,
    runtimeSeconds: input.runtimeSeconds,
    rawUsage: input.rawUsage
  };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

// Computes the dollar amount per the three formulas in PROJECT_BRIEF §4.
// Returns a fixed-precision string so callers can write it straight into the
// NUMERIC(14,6) cost_records.cost_usd column without floating-point drift.
export function computeCostUsd(source: CostSource, tokens: TokenCounts): string {
  if (source.source === "provider_direct") {
    const cachedCost =
      source.cachedInputCostPerMillion === null
        ? 0
        : (tokens.cachedTokens * source.cachedInputCostPerMillion) / 1_000_000;
    const dollars =
      (tokens.inputTokens * source.inputCostPerMillion) / 1_000_000 +
      (tokens.outputTokens * source.outputCostPerMillion) / 1_000_000 +
      cachedCost;
    return formatUsd(dollars);
  }
  if (source.source === "codexbar") {
    const totalTokens = tokens.inputTokens + tokens.outputTokens + tokens.cachedTokens;
    if (source.observedMaxMonthlyTokens <= 0) {
      return formatUsd(0);
    }
    return formatUsd((source.subscriptionMonthlyFee / source.observedMaxMonthlyTokens) * totalTokens);
  }
  return formatUsd(source.hourlyOpportunityCostUsd * (source.runtimeSeconds / 3600));
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.000000";
  }
  return value.toFixed(6);
}

export const costSourceConstants = {
  codexbarSubscriptionMonthlyFeeUsd,
  codexbarTheoreticalMaxMonthlyTokens
} as const;
