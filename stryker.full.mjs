/**
 * WHOLE-REPO mutation entrypoint (`just mutation-full`).
 *
 * This mutates the ENTIRE orchestrator backend — services/orchestrator/src/**
 * — not a single high-value cluster. It is EXPENSIVE (thousands of mutants ×
 * the full vitest suite per mutant under coverageAnalysis "all") and is
 * therefore NOT part of the per-PR gate (`just ci` / `just fast-check`). It is
 * driven only on demand and by the WEEKLY scheduled job
 * (.github/workflows/mutation-weekly.yml).
 *
 * SCOPE NOTE — orchestrator only. The dashboard (services/dashboard/src/**, a
 * React/Vite app exercised by component + Playwright e2e tests, not the vitest
 * unit suite Stryker drives here) and the CLI (cli/src/**) are deliberately NOT
 * in scope: their tests are a different runner/harness and would need their own
 * Stryker config + vitest project. The backend logic this repo's correctness
 * hinges on lives under the orchestrator. If/when the dashboard + cli get
 * vitest-driven unit coverage, add stryker.dashboard.mjs / stryker.cli.mjs as
 * sibling whole-package entrypoints rather than widening this scope.
 *
 * The per-cluster configs (stryker.runloop/alloc/wf/forge/notify/secrets/
 * repos/worker/dal.mjs) carry the per-cluster `break` FLOORS that gate
 * regressions on demand. This whole-repo run has NO break floor: it tracks the
 * GLOBAL trend over time (the weekly job records the number); the cluster
 * floors do the gating.
 */
const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: ["services/orchestrator/src/**/*.ts"],
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/full/index.html" },
  jsonReporter: { fileName: "reports/mutation/full/mutation.json" },
  // No `break` floor here — this is a TREND tracker, not a gate. The first
  // whole-repo number is produced by the initial scheduled weekly run (the
  // full run is too slow to complete on the authoring branch); record it in
  // docs/contracts/mutation-testing.md once the first weekly run lands. The
  // per-cluster configs hold the regression floors.
  thresholds: { high: 80, low: 60, break: 0 },
  logLevel: "info",
  tempDirName: "reports/mutation/.stryker-tmp-full",
  concurrency: 4,
  // Whole-repo mutants include some heavier loop paths; give each a generous
  // ceiling so a slow mutant is not miscounted as a kill-by-timeout.
  timeoutMS: 120000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite plus
  // Stryker's whole-repo instrumentation is close to that ceiling on GitHub's
  // ubuntu-latest runner (June 8 run: 3m43s; June 15+ runs: >5m timeouts as
  // the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};

export default config;
