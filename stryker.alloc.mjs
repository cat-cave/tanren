const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: [
    "services/orchestrator/src/engine/allocators/**/*.ts",
    "services/orchestrator/src/engine/contracts/allocator.ts",
  ],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-allocators). The allocator cluster
  // was strengthened from 68.47% to 84.03% (allocators subdir 68.30% -> 83.94%);
  // `break` is set just below the measured score so this run passes today and a
  // regression below the floor fails. Remaining survivors are dominated by
  // genuine equivalents (unused `_reason` default, injected sleep/clientFactory/
  // poll-interval defaults, `>= deadline` boundary). See the PR body.
  thresholds: { high: 80, low: 60, break: 82 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-alloc",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
