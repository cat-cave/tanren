// Scoped mutation run for the writer commit-gate recovery path. Narrow on purpose:
// mutation testing is slow, and the question here is only whether the new tests
// actually PIN the new behaviour (the classification seam, the adapter reporting,
// and the loop routing) rather than merely executing it.
const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: [
    "services/orchestrator/src/engine/providers/writerCommitGate.ts",
    "services/orchestrator/src/engine/workflow/commitGateSteering.ts",
  ],
  reporters: ["clear-text"],
  thresholds: { high: 80, low: 60, break: 0 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-commit-gate",
  concurrency: 4,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 15,
};
export default config;
