const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Repositories (DAL state stores) cluster — REFACTOR-TARGET baseline.
  // These row-decoder / SQL-builder stores (RunStore / SpecStore / JobStore /
  // TaskStore / ActorStore) are slated for the control-plane/data-plane +
  // RLS rearchitecture, so a baseline is captured BEFORE refactoring. Their
  // unit suite (stateRepositories.test.ts) drives each store through a recording
  // stub client and asserts the decoded row shape + emitted SQL/params, so the
  // mutation score reflects real, DB-free behavior pinning.
  mutate: ["services/orchestrator/src/engine/repositories/**/*.ts"],
  reporters: ["clear-text"],
  // Baseline (FIRST MEASUREMENT — refactor-target). Measured on this branch:
  // 51.28% (20 killed of 39 mutants; per-file: actors 100, runs 75, specs 66.67,
  // tasks 37.50, jobs 25.00). `break` is set just below the measured score so the
  // run passes today and any regression below the floor fails. This is a baseline,
  // not a strengthening pass: production source is unchanged here. The dominant
  // survivors are the SELECT_*_COLUMNS SQL-column StringLiterals and ORDER BY /
  // LIMIT clause text the DB-free stub suite does not assert against a live query.
  thresholds: { high: 80, low: 60, break: 50 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-repos",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
