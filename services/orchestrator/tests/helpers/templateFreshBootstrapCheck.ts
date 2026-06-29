// Shared "the composed scaffold bootstraps from a FRESH checkout" check for the
// template-fragment harnesses.
//
// The helper itself lives in the RUNTIME location now (audit finding #12 — lift
// to `src/engine/templates/fragments/runtimeValidation.ts`) so the live
// fragment-authoring smoke pipeline catches the same `apex v63` halt class
// (ERR_PNPM_NO_LOCKFILE + Dockerfile equivalents) the static harnesses
// (templateFragmentIsolation, templateFragmentMatrixCoverage) catch. The helper
// was also renamed to `assertScaffoldBootstrapsFromFreshCheckout` because its
// scope grew from "justfile bootstrap recipe" to "justfile + Dockerfile RUN
// lines" (audit finding #10).
//
// This file remains as the test-side import path the existing tests use; it
// re-exports the runtime helper unchanged.

export { assertScaffoldBootstrapsFromFreshCheckout } from "../../src/engine/templates/fragments/runtimeValidation.js";
