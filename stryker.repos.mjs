const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Repositories (DAL state stores) cluster — REFACTOR-TARGET baseline.
  // These row-decoder / SQL-builder stores (RunStore / SpecStore / JobStore /
  // TaskStore / ActorStore) are slated for the control-plane/data-plane +
  // RLS rearchitecture, so a baseline is captured BEFORE refactoring. Their
  // unit suite (stateRepositories.test.ts) drives each store through a recording
  // stub client and asserts the decoded row shape + emitted SQL/params, so the
  // mutation score reflects real, DB-free behavior pinning.
  mutate: ["services/orchestrator/src/engine/repositories/**/*.ts"],
  reporters: ["clear-text"],
  // Strengthened (mutation ratchet). The stateRepositories suite was extended
  // with behavior-pinning tests asserting each store's emitted SQL (full column
  // projection, WHERE/ORDER BY, dynamic SET fragments, RETURNING, params), the
  // row->entity coercions (string<->number for id/attempts/attempt), the spec
  // array-field filtering, status transitions, and not-found handling. Score
  // rose 51.28% -> 84.62% (33 killed of 39; per-file: actors 100, runs 100,
  // specs 100, tasks 75, jobs 66.67). The remaining 6 survivors are GENUINE
  // EQUIVALENTS: the decoder guards `typeof raw.x === "string"/"number" ? raw.x
  // : String/Number(raw.x)` collapse to the else branch under the conditional-
  // false and `=== ""` mutants, and String(s)===s / Number(n)===n for every
  // in-domain input, so no behavioral test can distinguish them. `break` is set
  // just below the measured score so any regression below the floor fails.
  // Production source is unchanged.
  thresholds: { high: 90, low: 70, break: 84 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-repos",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
