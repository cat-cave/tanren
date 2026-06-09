// Single import surface for Tanren-native templating. Two surfaces meet here:
//
//   WAVE 1 — the template OBJECT: the `.tanren/template.yml` manifest schema + its
//   fail-loud parser (manifest.ts). The registry STORE rides the `Repositories` seam
//   (engine/repositories/templates.ts); the operator routes live under
//   routes/templates. The manifest carries the CANONICAL validation-proof shape
//   (`TemplateValidationProof` + `NegativeControlResult`).
//
//   WAVE 2 — the VALIDATION HARNESS (validationHarness.ts / negativeControls.ts /
//   scratchCopy.ts / validationProof.ts): it PROVES a template's gates actually CHECK
//   — the "meaningful, not green-by-accident" oracle (templating-system.md §2.4). The
//   harness produces a `TemplateValidationProof` (wave 1's shape — unified, no
//   duplicate type), so its output populates `TemplateManifestV1.validationProof`
//   directly; `templateValidates(proof)` is the published-or-not verdict.
export {
  NegativeControlResult,
  TemplateCapabilities,
  TemplateChannel,
  TemplateManifestV1,
  TemplateManifestValidationError,
  TemplateManifestYamlParseError,
  TemplateProvenance,
  TemplateValidationProof,
  manifestToJson,
  parseTemplateManifest,
} from "./manifest.js";
export { runValidationHarness, type TemplateAuditor, type ValidationHarnessInput } from "./validationHarness.js";
export { NEGATIVE_CONTROL_CAPABILITIES, templateValidates } from "./validationProof.js";
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
