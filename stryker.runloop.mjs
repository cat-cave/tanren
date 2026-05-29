const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.ts", related: false },
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
};
export default config;
