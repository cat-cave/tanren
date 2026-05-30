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
  // Ratcheted floor (test/mutation-ratchet-workflow-stages). The workflow-stage
  // cluster was strengthened from 70.00% to 91.33% (subtaskStages 67.15% ->
  // 90.51%; subtaskCost already 100%); `break` sits just below the measured
  // score so this run passes today and a regression below the floor fails.
  // The 13 remaining survivors are genuine equivalents: every emitStageTiming(...)
  // arg (stage-name string / `Date.now() - startedAt` / attributes object) feeds
  // only the default consoleTimingSink (no injectable sink at the call site), so
  // it lands in a best-effort structured log line with no event/DB/return/cost
  // observable; and `Buffer.byteLength(diff, "utf8") -> ""` is byte-for-byte
  // identical because Node falls back to utf8 for an unknown encoding. See the PR.
  thresholds: { high: 80, low: 60, break: 90 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-wf",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
