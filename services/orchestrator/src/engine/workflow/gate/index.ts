// The in-loop native gate-check barrel. The deterministic, exit-code-driven
// verification half AND the merge authority: runs CI tiers over SSH on the
// bootstrapped workspace and returns a typed pass/fail; the `pre_merge` tier is
// the native merge gate (no forge check-run poll). No Answerer lives here.
export {
  runGateTier,
  type GateAppendEvent,
  type GateStepOutcome,
  type GateTierResult,
  type RunGateTierInput,
} from "./runGateTier.js";
export { runGateForWhen, type GateOutcome, type RunGateForWhenInput } from "./runGateForWhen.js";
export {
  GateConfigReadError,
  resolveBootstrapCommand,
  resolveGateConfig,
  type ResolveGateConfigInput,
} from "./resolveGateConfig.js";
export {
  CI_CONFIG_GATE_STEP,
  CI_CONFIG_GATE_TIER,
  invalidCiConfigGateOutcome,
  isInvalidCiConfigError,
} from "./gateConfigFailure.js";
export { advisoryStepNamesForPosture } from "./advisoryGate.js";
export { runNativeMergeGate } from "./runMergeGate.js";
export { publishGateVerdict, type PublishGateVerdictInput } from "./publishGateVerdict.js";
export { publishGateVerdictBestEffort, type EmitPublishFailed } from "./publishGateVerdictBestEffort.js";
export { ingestGateJunit, type IngestGateJunitInput, type IngestGateJunitResult } from "./ingestGateJunit.js";
