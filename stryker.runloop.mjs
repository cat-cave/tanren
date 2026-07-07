const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: [
    "services/orchestrator/src/engine/workflow/planner/**/*.ts",
    "services/orchestrator/src/engine/workflow/checker/**/*.ts",
    "services/orchestrator/src/engine/workflow/auditor/**/*.ts",
    "services/orchestrator/src/engine/workflow/plannerRun.ts",
    "services/orchestrator/src/engine/workflow/subtaskLoop.ts",
    "services/orchestrator/src/engine/workflow/subtaskRework.ts",
    "services/orchestrator/src/engine/workflow/subtaskAccounting.ts",
  ],
  reporters: ["clear-text"],
  thresholds: { high: 80, low: 60, break: 0 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-runloop",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
