// Shared CiConfigV1 parse check for the template-fragment harnesses.
//
// The helper itself lives in the RUNTIME location now (audit finding #12 — lift
// to `src/engine/templates/fragments/runtimeValidation.ts`) so the live
// fragment-authoring smoke pipeline catches the same `apex v62` halt class the
// static harnesses (templateFragmentIsolation, templateFragmentMatrixCoverage)
// catch. This file remains as the test-side import path the existing tests use;
// it re-exports the runtime helper unchanged so callers do not need a rewrite.

export { assertComposedCiYmlParsesAsCiConfigV1 } from "../../src/engine/templates/fragments/runtimeValidation.js";
