const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Cost-attribution + DORA/insights analytics cluster. Disjoint from the
  // run-loop (#107), allocator (#147), workflow-stage (#149), forge (#152),
  // notifications (#157), secret-store (#160), inbox (#163), auth (#166), and
  // the refactor-target backend (repos/worker/dal) clusters: this covers the
  // 4-source cost model + CostRecorder/apportionment (`engine/costs/**`) and
  // the DORA reducer + insight detectors (`engine/insights/**`).
  mutate: ["services/orchestrator/src/engine/costs/**/*.ts", "services/orchestrator/src/engine/insights/**/*.ts"],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-costs-insights). The cost +
  // DORA/insights cluster was strengthened from 68.46% to 87.54%. Per file:
  // sources 76.62->88.96, recorder 71.83->80.28, dora/compute 59.49->92.41,
  // dora/types 100, cache 78.43->86.27, computer 84->88, modelMismatch
  // 68.29->85.37, paceAnomaly 55.17->86.21, retryHotspot 65.75->86.30,
  // reviewStall 59.09->90.91, stuck 59.57->82.98, types 85.94->93.75. New
  // behavior-based tests drive real recorded outcomes: the 4-source cost
  // resolution + provider-pricing math (per-bucket token rates, cached/reasoning
  // billing, ccusage/credits precedence + finite/positive guards), the
  // CostRecorder INSERT column shape + token-share apportionment so rows sum to
  // the run total, the DORA reducer (median even/odd, negative/zero-gap
  // filtering, deploy-freq divisor, change-failure boundary statuses) + the DB
  // loader window math, and the insight detectors' thresholds + severity
  // classification + operator-facing title/body/action text (stuck chain-depth
  // + pluralization, review-stall phase/threshold/2x severity/humanHours,
  // model-mismatch ratio/cheapest+most-recent selection/monthlySavings,
  // pace-anomaly multiplier/subtaskIndex/humanDuration, retry-hotspot
  // count/window/model-fallback, cache freshness cutoff, computer dispatch,
  // types superRefine kind-mismatch). `break` sits just below the measured score
  // so this run passes today and a regression below the floor fails. The ~99
  // remaining survivors are dominated by genuine equivalents: SQL-string literals
  // the in-memory fake matches by prefix (column lists, ORDER BY, JOIN text), the
  // recorder credits-guard sub-conditions that are observationally identical
  // (consumed=0 still no-ops downstream), `?? null` / `?? 0` row defaults on
  // columns the fixtures always populate, and the production `= new Date()` /
  // `now()` defaults (every compute path injects `now`). See the PR body.
  thresholds: { high: 80, low: 60, break: 87 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-costs",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
