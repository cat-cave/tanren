// Barrel for the P2A-0011 cost-record-persistence surface. Importing from
// here is the only supported way for workflow code to attribute and persist
// LLM cost; the workflow MUST call CostRecorder.record at task completion
// and propagate CostUnattributableError so the task fails with
// failureKind="cost.unattributable" and the run halts.
export {
  CostSource,
  type RawUsage,
  PricingMode,
  type AttributionInput,
  CostUnattributableError,
  classifyAuthRef,
  computeCostUsd,
  costSourceConstants,
  providerRate,
  resolveCostSource,
  type TokenCounts
} from "./sources.js";

export { CostRecorder, type CostRecordContext, type RecordedCost } from "./recorder.js";
