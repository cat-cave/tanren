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
  DEFAULT_CREDIT_USD_RATE,
  type AttributionInput,
  type ProviderRate,
  classifyAuthRef,
  computeCostUsd,
  computeNotionalUsd,
  providerRate,
  resolveCostSource,
} from "./sources.js";

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
