const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
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
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
