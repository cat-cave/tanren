const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // DAL / org-scope cluster — REFACTOR-TARGET baseline. This is the data-access
  // seam at the heart of the RLS + control-plane/data-plane split: the
  // org-scoped query client (`resolveQueryClient` in engine/data/orgScopedDb.ts)
  // and the AsyncLocalStorage scope machinery + system/runtime pool wiring
  // (`runWithOrgScope` / `getOrgScopedClient` / `runWithSystemScope` /
  // `getSystemPool` in db/src/orgScope.ts). These are the exact query-routing
  // primitives the R-waves rearchitect, so a baseline is captured BEFORE the
  // refactor. NOTE: the strongest coverage (the SET LOCAL app.current_org_id
  // transaction, the policy-scoped reads/writes) lives in the RLS_DB-gated
  // integration suite (rlsR2*/rlsR3a*), which SKIPS without TANREN_RLS_DB_TEST=1
  // + a superuser Postgres. The DB-free baseline below therefore understates the
  // true strength; the weekly job should run the RLS DB harness for the full
  // number (see docs/contracts/mutation-testing.md).
  mutate: ["services/orchestrator/src/engine/data/**/*.ts", "db/src/orgScope.ts"],
  reporters: ["clear-text"],
  // Baseline (FIRST MEASUREMENT — refactor-target, DB-free). Measured on this
  // branch: 38.89% (35 killed of 90 mutants; orgScope.ts 44.64%, orgScopedDb.ts
  // 29.41%). `break` is set just below the measured DB-FREE score so the run
  // passes today and any regression below the floor fails. This is a baseline,
  // not a strengthening pass: production source is unchanged here. The survivors
  // concentrate in the SET LOCAL transaction body + policy-scoped read/write
  // routing that only the RLS_DB-gated integration suite exercises — run the
  // RLS DB harness (TANREN_RLS_DB_TEST=1) for the true, higher score.
  thresholds: { high: 80, low: 60, break: 36 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-dal",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
