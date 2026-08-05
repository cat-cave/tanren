// Barrel for the cost-record-persistence surface. Importing from here is the
// only supported way for workflow code to attribute and persist LLM cost; the
// workflow MUST call CostRecorder.record at task completion. Token accounting
// is mandatory; cost in dollars is best-effort (NULL when unknown), so the
// recorder never halts a run for missing cost.
export {
  type CostSource,
  type RawUsage,
  BillingMode,
  CostBasis,
  type AttributionInput,
  classifyAuthRef,
  computeCostUsd,
  credentialSlugOf,
  refKindOf,
  resolveCostSource,
} from "./sources.js";
export {
  billableTokenTotal,
  computeNotionalUsd,
  LoudNotionalReason,
  NotionalReason,
  type NotionalResult,
  notionalReasonIsLoud,
} from "./notional.js";

// cost PR-C: per-credential credit/overage USD-rate resolution + the honest
// Claude-overage seam. The credit-drawdown reconcile resolves the rate from
// CONFIG (never a constant); the Claude overage path is a LOUD honest gap.
export { type CreditRateResolution, resolveCreditUsdRate } from "./creditRate.js";
export { type ClaudeOverageReachability, classifyOverageReachability } from "./claudeOverage.js";

export { CostRecorder, type CostRecordContext, type RecordedCost } from "./recorder.js";

// OpenRouter's authoritative per-call cost query (the `provider_response` real-
// spend capture path). The only provider surface that hands back a real-dollar
// figure per generation; BYOK-aware (see openRouterCost.ts).
export {
  type OpenRouterCostQueryInput,
  type OpenRouterGenerationCost,
  type OpenRouterHttpClient,
  type OpenRouterHttpRequest,
  type OpenRouterHttpResponse,
  queryGenerationCost,
  realProviderCostFrom,
} from "./openRouterCost.js";

// ModelPriceSource — the REAL, MAINTAINED per-model rate source (LiteLLM's
// `model_prices_and_context_window.json`). Any COMPUTED figure (notional cost,
// forward spec/DAG estimate) sources its rates HERE, never a hardcoded table; a
// model in NEITHER the live table NOR the vendored seed resolves to a LOUD `null`.
// `LiveModelPriceSource` fetches upstream on a short TTL (self-healing for new
// models) with the vendored file demoted to an offline seed/fallback; the frozen
// `defaultModelPriceSource()` stays the deterministic offline source for tests.
export {
  type LiveModelPriceSourceOptions,
  type ModelPrice,
  type ModelPriceFetcher,
  type ModelPriceMap,
  LiveModelPriceSource,
  ModelPriceSource,
  type RateAxis,
  defaultModelPriceSource,
  liveFetchEnabled,
  liveModelPriceSource,
} from "./pricing/modelPriceSource.js";
