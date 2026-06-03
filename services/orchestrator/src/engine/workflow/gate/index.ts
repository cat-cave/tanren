// P3-0005 in-loop gate-check stage barrel. The deterministic, exit-code-driven
// verification half: runs CI tiers over SSH on the bootstrapped workspace and
// returns a typed pass/fail. No Answerer lives here.
export {
  runGateTier,
  type GateAppendEvent,
  type GateStepOutcome,
  type GateTierResult,
  type RunGateTierInput,
} from "./runGateTier.js";
export { runGateForWhen, type GateOutcome, type RunGateForWhenInput } from "./runGateForWhen.js";
export { resolveBootstrapCommand, resolveGateConfig, type ResolveGateConfigInput } from "./resolveGateConfig.js";
export { advisoryStepNamesForPosture } from "./advisoryGate.js";
