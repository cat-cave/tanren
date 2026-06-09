// The Tanren-native templating barrel (wave 2: the validation harness). A template is
// a conforming repo (stack-flexible-contract.md); this surface proves a template's
// gates actually CHECK — the "meaningful, not green-by-accident" validation
// (templating-system.md §2.4). The registry/metadata (wave 1), creation flow, and
// Forge interview integration live in their own waves.
export { runValidationHarness, type TemplateAuditor, type ValidationHarnessInput } from "./validationHarness.js";
export {
  templateValidates,
  type NegativeControls,
  type NegativeControlVerdict,
  type ValidationProof,
  NEGATIVE_CONTROL_CAPABILITIES,
} from "./validationProof.js";
export {
  buildNegativeControlPlan,
  failingTestDefect,
  lintViolationDefect,
  mutationSeedDefect,
  type GateInvocation,
  type InjectedDefectFile,
  type NegativeControl,
  type NegativeControlCapability,
  type NegativeControlPlanInput,
  type PlantedDefect,
  typeErrorDefect,
  DEFAULT_TS_COVERED_SOURCE_PATH,
  DEFAULT_TS_TEST_PATH,
  DEFAULT_TS_MUTATION_SEED_PATH,
} from "./negativeControls.js";
export { ScratchCopyError } from "./scratchCopy.js";
