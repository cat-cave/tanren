// spec-quality barrel — workstream 1 of the spec-loop redesign.
//
// The single import surface for the spec-creating-agent contract: the reusable
// PROMPT fragment + the strict validation SCHEMA (re-exported from the answerer
// schemas), the spec-VALIDATION answerer, and the `validateEmittedSpecs` gate.
// Spec-emitters and the loop's TRIAGE (workstream 2) import from here so wiring the
// contract is a one-import call.

export {
  SPEC_QUALITY_ANSWER_SCHEMA_ID,
  SPEC_QUALITY_CONTRACT_PROMPT,
  SPEC_QUALITY_OUTPUT_INSTRUCTIONS,
  SpecQualityAnswer,
} from "../../answerers/schemas/specQuality.js";

export {
  buildSpecQualityPrompt,
  wrapProviderSpecQualityAnswerer,
  type CandidateSpec,
  type SpecQualityAnswerer,
  type WrapProviderSpecQualityAnswererOptions,
} from "./validator.js";

export {
  validateEmittedSpecs,
  PersistentlyInvalidSpecError,
  type ReviseSpec,
  type ValidateEmittedSpecsInput,
  type ValidateEmittedSpecsResult,
  type ValidatedSpec,
} from "./stage.js";
