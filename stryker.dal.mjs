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
  // STRENGTHENED (DB-free behavior tests for the org-scope resolver logic).
  // Measured on this branch after adding tests/orgScopeResolvers.test.ts: 97.78%
  // (88 killed of 90 mutants; orgScopedDb.ts 100.00%, orgScope.ts 96.43%) — up
  // from the 38.89% first-measurement baseline. The new DB-free tests pin the
  // resolver routing Stryker CAN reach (real AsyncLocalStorage + a recording fake
  // pool/client): resolveQueryClient / resolveWritableClient (ambient connection
  // scope → per-job-org short txn → bare pool, and handed-client-verbatim), the
  // isPool / hasOrgScope discriminators, withJobOrgScope + orgScopingPool (one
  // short txn per op, the proxy's bind/delegate trap), runWithJobOrgId /
  // getJobOrgId (ALS get/set), runWithOrgScope / runWithSystemScope (BEGIN /
  // SET LOCAL / COMMIT vs ROLLBACK ordering + client release), the assertSafeOrgId
  // injection guard, and the getSystemPool env-driven memo.
  //
  // The 2 residual survivors cannot be killed DB-free:
  //   - orgScope.ts:137 `new Pool({ connectionString: url })` → `new Pool({})`:
  //     only a REAL connection distinguishes the connection string; this is
  //     proven by the TANREN_SYSTEM_DATABASE_URL path in the RLS_DB-gated
  //     integration suite (rlsR3b*), which Stryker SKIPS without
  //     TANREN_RLS_DB_TEST=1 + a superuser Postgres.
  //   - orgScope.ts:125 `let systemPoolResolved = false` → `true`: a module-level
  //     INITIAL-STATE literal that is equivalent to the resetSystemPool() path
  //     (which sets it false) — unobservable in-process once the memo is touched.
  // `break` is set just below the measured DB-free score so the run passes today
  // and any regression below the floor fails. The RLS_DB harness
  // (TANREN_RLS_DB_TEST=1) raises the number further on the SET LOCAL txn body +
  // policy-scoped read/write routing (see docs/contracts/mutation-testing.md).
  thresholds: { high: 80, low: 60, break: 97 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-dal",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
