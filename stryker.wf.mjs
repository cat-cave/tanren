const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: [
    "services/orchestrator/src/engine/workflow/subtaskStages.ts",
    "services/orchestrator/src/engine/workflow/subtaskCost.ts",
  ],
  reporters: ["clear-text"],
  thresholds: { high: 80, low: 60, break: 0 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-wf",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
