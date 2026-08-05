// Mutation cluster for the REGRESSION CONTRACT (the per-iteration pass→fail transition
// judgment). Run with `corepack pnpm exec stryker run stryker.regression.mjs`.
//
// SCOPE: the contract's own pure core and its baseline capture. `runGateTier.ts` is
// deliberately NOT mutated wholesale — it is a large pre-existing module whose mutants
// would mix this change's test strength with the historical baseline and make the number
// meaningless. The contract's behaviour inside that file is covered by
// gateRegressionContract.test.ts, which drives the real tier runner end to end.
const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // A NARROWED vitest config (see the file's header): the whole-suite run the other
  // clusters use costs ~180s per mutant, which is unaffordable at this cluster's size.
  vitest: { configFile: "vitest.stryker.regression.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: [
    "services/orchestrator/src/engine/ci/regression.ts",
    "services/orchestrator/src/engine/workflow/gate/regressionJudgment.ts",
    "services/orchestrator/src/engine/workflow/gate/captureRegressionBaseline.ts",
  ],
  reporters: ["clear-text"],
  // Measured 87.32% overall: regression.ts 100.00% (46/46), regressionJudgment.ts 89.09%,
  // captureRegressionBaseline.ts 73.68%. `break` sits just below the measured score so this
  // passes today and a regression below the floor fails.
  //
  // The 25 survivors + 2 no-coverage are equivalents in four groups:
  //   (a) `log.error("…")` message strings and their structured-detail objects (all in
  //       captureRegressionBaseline) — the function's observable contract is its returned
  //       discriminated result; the log line has no event/DB/return consumer. Same class the
  //       workflow-stages cluster documents for emitStageTiming.
  //   (b) `buildActivityWatchdog({ cls: "vcs", … })` config handed to a collaborator, which
  //       produces no difference a substrate mock can observe.
  //   (c) the `kind: "verdict"` discriminant string, reachable only through an exhaustive
  //       switch whose other arm is already pinned.
  //   (d) the 2 no-coverage mutants inside the `never` exhaustiveness guard — unreachable by
  //       construction, which is the point of the guard.
  // Three earlier survivor groups were NOT equivalents and were fixed rather than excused:
  // a redundant hand-rolled comparator (deleted — the default sort is already code-unit
  // ordered), an `unreadable` reason payload no caller read (deleted), and a `timedOut`
  // expression that was constant-false by construction (replaced with the invariant).
  thresholds: { high: 90, low: 70, break: 85 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-regression",
  concurrency: 4,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 15,
};
export default config;
