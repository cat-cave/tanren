import { mergeConfig } from "vitest/config";
import strykerConfig from "./vitest.stryker.config.ts";

// Vitest config for the REGRESSION-CONTRACT mutation cluster (stryker.regression.mjs).
//
// The other clusters run the WHOLE suite against every mutant (`coverageAnalysis: "all"`)
// because this repo's `.js`-extension ESM imports defeat vitest's changed-file heuristic,
// making per-test attribution silently report 0% coverage. That is affordable for them and
// not here: the full suite is ~180s, so a cluster of a few hundred mutants would take days.
//
// This config narrows the RUN to the four test files that exercise the regression contract
// and nothing else, which keeps `coverageAnalysis: "all"` honest (every mutant still runs
// every test in this set) while bringing a mutant's cost to a couple of seconds. The
// trade-off is explicit: a mutant killed only by some unrelated test elsewhere in the
// repo will show as SURVIVED here. That is the conservative direction — it understates
// the score rather than overstating it.
export default mergeConfig(strykerConfig, {
  test: {
    include: [
      "services/orchestrator/tests/ciRegression.test.ts",
      "services/orchestrator/tests/ciRegressionConfig.test.ts",
      "services/orchestrator/tests/captureRegressionBaseline.test.ts",
      "services/orchestrator/tests/gateRegressionContract.test.ts",
      "services/orchestrator/tests/testRegressionDirective.test.ts",
      "services/orchestrator/tests/gateRunner.test.ts",
      "services/orchestrator/tests/evidenceBasedGates.test.ts",
    ],
  },
});
