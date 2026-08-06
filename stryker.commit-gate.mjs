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
  // `break` is the score BELOW which the run FAILS — the actual pin. The recovery/boundary
  // suites are written to kill every mutant in these two files, so the floor is 100: a
  // future edit that removes a recovery assertion lets a mutant survive and FAILS this run,
  // rather than silently passing (which `break: 0` would have allowed).
  thresholds: { high: 100, low: 100, break: 100 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-commit-gate",
  concurrency: 4,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 15,
};
export default config;
