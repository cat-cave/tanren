const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Run executor / worker cluster — REFACTOR-TARGET, now STRENGTHENED. This is
  // the run-execution data plane (the worker that claims a queued run job, builds
  // the execution context, drives the workflow loop, and reaps expired leases),
  // slated for the control-plane/data-plane split + the eventual native/Rust
  // harness, so full mutation confidence is captured BEFORE refactoring. Disjoint
  // from the run-loop cluster (stryker.runloop.mjs covers engine/workflow/**, not
  // engine/worker/**). Behavior coverage: workerBoot.test.ts (boot / identity
  // seeding / RunWorker drain), workerLifecycle.test.ts (startRunWorker concurrency
  // + dep wiring), claimClientFromEnv.test.ts (the P2 claim seam), jobReaper.test.ts
  // (requeue / dead-letter / loop), runExecutionContext.test.ts (context hydration),
  // and runExecutor.test.ts + runWorker.test.ts (claim→execute, org-scope, quota
  // gate/accrual, finalize, exit-reason classification, slot lifecycle).
  mutate: ["services/orchestrator/src/engine/worker/**/*.ts"],
  reporters: ["clear-text"],
  // Strengthening pass (behavior-based tests only; production source unchanged).
  // Baseline was 38.25% (first measurement); re-measured on this branch's tip at
  // 36.00% before the pass. After: 70.95% (324 killed + 13 timeout of 475; per
  // file: claimClientFromEnv 96.15, runExecutionContext 87.50, runWorker 81.54,
  // boot 73.17, jobReaper 68.82, runExecutor 68.02, lifecycle 50.00). `break` is
  // set just below the measured score so the run passes today and any regression
  // below the floor fails. Remaining survivors are genuine equivalents (the
  // SIGTERM/SIGINT signal-handler wiring calls process.exit, untestable without
  // killing the runner) or DB-bound SQL branches only the RLS_DB-gated suite
  // drives; the weekly full run surfaces the rest.
  thresholds: { high: 80, low: 60, break: 69 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-worker",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
