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
