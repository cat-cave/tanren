/**
 * Stryker mutation testing — Track C §5 of
 * docs/architecture/portability-and-longevity.md.
 *
 * Mutation testing turns "how strong are the tests" into a number: Stryker
 * introduces small faults (mutants) into the SCOPED source and checks whether
 * the existing vitest suite catches them. A mutant that survives is a behavior
 * the tests do not actually pin.
 *
 * SCOPE (highest-value modules only — mutation testing is slow, so it is NOT
 * run repo-wide and is deliberately kept OUT of the per-PR `just ci` /
 * `just fast-check` gate). It is an on-demand / nightly check (`just mutation`).
 *
 * The scope is the workflow-critical reasoning modules plus the
 * conformance-covered adapter seams:
 *   - workflow planner / checker / auditor (the autonomous run's reasoning)
 *   - engine/credentials/** (credential resolution + materialization)
 *   - the Allocator / JobQueue / SecretStore seam contracts (conformance-covered)
 *   - the concrete allocators behind the Allocator seam
 */
const config = {
  testRunner: "vitest",
  // pnpm's isolated node_modules means the default `@stryker-mutator/*` plugin
  // glob does not always resolve the runner; declare it explicitly.
  plugins: ["@stryker-mutator/vitest-runner"],
  // Stryker manages coverage/reporters internally; it points the vitest runner
  // at the Stryker-specific config (same module resolution + @tanren/db alias as
  // the repo root, plus the one extra exclusion the mutation run needs). That
  // config drops `scripts/gen-dashboard-types.test.ts`: under Stryker the suite
  // runs from a COPIED sandbox, so that gate's spawned `--check` re-derives the
  // dashboard types from the sandbox copy and reports drift against the committed
  // file — aborting the un-mutated initial dry run. It is environmental to the
  // sandbox, exercises no mutated source, and is already enforced by `just`/CI.
  vitest: {
    configFile: "vitest.stryker.config.ts",
    // `related: true` (the default) uses vitest's changed-file heuristic to
    // pick which test files even load. With this repo's `.js`-extension imports
    // + the `@tanren/db` alias, that heuristic failed to associate the
    // planner/checker/auditor tests with their source. Disabling it loads the
    // full suite so every scoped module's tests actually run.
    related: false,
  },
  // `coverageAnalysis: "all"` (not the faster "perTest") is required here.
  // perTest asks the runner to attribute each mutant to the specific tests
  // that cover it; with this repo's ESM `.js`-extension imports + `@tanren/db`
  // alias, that attribution silently fails for the workflow planner/checker/
  // auditor modules — every mutant in them is reported as "no coverage" and
  // the score reads a false 0%, even though plannerLoop.test.ts imports and
  // exercises them. "all" runs the full suite against each mutant (slower, but
  // this is an on-demand/nightly check, not the per-PR gate) and yields an
  // honest score. See the `thresholds` note below for the measured baseline.
  coverageAnalysis: "all",
  // ONLY the scoped modules are mutated. Everything else is untouched.
  mutate: [
    // Workflow-critical reasoning modules.
    "services/orchestrator/src/engine/workflow/planner/**/*.ts",
    "services/orchestrator/src/engine/workflow/checker/**/*.ts",
    "services/orchestrator/src/engine/workflow/auditor/**/*.ts",
    // Credential resolution + materialization.
    "services/orchestrator/src/engine/credentials/**/*.ts",
    // Conformance-covered adapter seams.
    "services/orchestrator/src/engine/contracts/allocator.ts",
    "services/orchestrator/src/engine/contracts/jobQueue.ts",
    "services/orchestrator/src/engine/contracts/secretStore.ts",
    // Concrete allocators behind the Allocator seam.
    "services/orchestrator/src/engine/allocators/**/*.ts",
  ],
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Honest baseline ratchet (Track C §5). `break` is set just below the first
  // measured full-scope mutation score so `just mutation` passes today and any
  // regression below the floor fails the check. `high`/`low` only color the
  // report. Production code is intentionally NOT changed to kill mutants in this
  // PR — raising the floor is follow-up work; the value here is the number plus
  // the regression gate. See the architecture doc for the measured baseline and
  // the per-module breakdown.
  //
  // Measured full-scope baseline: 39.89% (926 killed + 64 timeout of ~2483
  // mutants). Note: the planner/checker/auditor modules report 0% in the
  // full-scope run as a Stryker scoping artifact — when measured in isolation
  // they score ~56% (planner 66 / checker 60 / auditor 39).
  //
  // chore/mutation-ratchet-runloop: the run-loop core cluster
  // (plannerRun / subtaskLoop / subtaskRework + planner/checker/auditor) was
  // measured in isolation (stryker.runloop.mjs, 594 mutants) at 55.39% and
  // strengthened to 81.99% — +158 newly-detected mutants (329 → 487 killed+timeout):
  //   auditor 40.82 → 97.96, checker 35.09 → 98.25, planner 41.94 → 98.39,
  //   plannerRun 53.11 → 68.36, subtaskLoop 69.29 → 86.43, subtaskRework 63.64 → 100.
  // Those +158 detected mutants land in the full-scope denominator too, so the
  // full-scope score rises to ~46% ((990 + 158) / 2483). The full re-measure is
  // too slow to block this PR, so the `break` floor is raised CONSERVATIVELY to
  // 42 — comfortably above the prior 38 and safely below the ~46% estimate, with
  // headroom for measurement variance. A precise full re-measure is follow-up.
  thresholds: {
    high: 80,
    low: 60,
    break: 42,
  },
  // Keep CI logs quiet; the html report carries the detail.
  logLevel: "info",
  // Drop generated reports under a single ignored dir.
  tempDirName: "reports/mutation/.stryker-tmp",
  concurrency: 4,
  timeoutMS: 60000,
};

export default config;
