const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Run executor / worker cluster — REFACTOR-TARGET baseline. This is the
  // run-execution data plane (the worker that claims a queued run job, builds
  // the execution context, drives the workflow loop, and reaps expired leases),
  // slated for the control-plane/data-plane split + the eventual native/Rust
  // harness, so a baseline is captured BEFORE refactoring. Disjoint from the
  // run-loop cluster (stryker.runloop.mjs covers engine/workflow/**, not
  // engine/worker/**). DB-free coverage comes from workerBoot.test.ts (boot /
  // RunWorker lifecycle against a stub pool), jobReaper.test.ts (lease requeue /
  // dead-letter), and acceptanceHardTier.test.ts (executeNextPlanJob end-to-end).
  mutate: ["services/orchestrator/src/engine/worker/**/*.ts"],
  reporters: ["clear-text"],
  // Baseline (FIRST MEASUREMENT — refactor-target). Measured on this branch:
  // 38.25% (159 killed + 7 timeout of 434 mutants; per-file: runExecutor 44.71,
  // runExecutionContext 41.67, jobReaper 40.86, runWorker 38.46, boot 25.00,
  // lifecycle 18.00). `break` is set just below the measured score so the run
  // passes today and any regression below the floor fails. This is a baseline,
  // not a strengthening pass: production source is unchanged here. Many survivors
  // are in DB-bound branches (claim/lease/lineage SQL, pool wiring) only the
  // RLS_DB-gated integration suite drives; the weekly run surfaces the rest.
  thresholds: { high: 80, low: 60, break: 36 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-worker",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
