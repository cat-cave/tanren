import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tanren/db": new URL("./db/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    reporters: ["default"],
    // P3-0029 observability: per-glob coverage thresholds for WORKFLOW-CRITICAL
    // modules — the planner-feedback loop stages, the answerer reasoning paths
    // (planner/checker/auditor), the cost-recording path, and the
    // credential-resolution path. These are per-glob ratchets set at or just
    // BELOW the measured coverage (so the gate does not go red) to guard
    // against regressions in the modules an autonomous run depends on.
    //
    // Strictness wave 2: a REPO-WIDE coverage floor is ALSO enforced (the
    // top-level `thresholds.{statements,branches,functions,lines}` below). The
    // `include` is broadened to all package `src/**` so the global numbers
    // reflect the whole codebase. The global floor is a non-breaking ratchet
    // set just BELOW the measured repo-wide baseline (see comment below) so it
    // prevents regression without coupling the suite to the exact numbers. The
    // per-glob thresholds above continue to key off their own subsets of the
    // broadened include. Observed coverage is noted per glob and globally.
    coverage: {
      provider: "v8",
      // Instrument every package's source so the repo-wide floor below is
      // computed against the whole codebase; per-glob thresholds still apply
      // to their (narrower) subsets of this set.
      include: ["cli/src/**", "db/src/**", "services/*/src/**"],
      thresholds: {
        // Strictness wave 2 — REPO-WIDE floor. RE-BASELINED for Vitest 4: the v8
        // coverage provider switched from v8-to-istanbul to AST-based remapping
        // (more accurate, so reported numbers dropped vs v3 — the SAME 3607 tests
        // still pass; a measurement change, not a coverage regression). Measured
        // under Vitest 4 over all src:
        //   statements 75.65%  branches 66.06%  functions 75.23%  lines 76.92%
        // Floors set just below each — non-breaking guards against regression of
        // the whole suite. (The per-glob workflow-critical floors below were
        // unaffected by the remapping and keep their original, higher values.)
        statements: 75,
        branches: 65,
        functions: 74,
        lines: 76,
        // Answerer reasoning paths — observed 100/100/100. Floor well below.
        "services/orchestrator/src/engine/workflow/auditor/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "services/orchestrator/src/engine/workflow/checker/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "services/orchestrator/src/engine/workflow/planner/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Loop stages — observed stmts/lines 100, branches 73.9, funcs 100.
        "services/orchestrator/src/engine/workflow/subtaskStages.ts": {
          statements: 90,
          branches: 60,
          functions: 90,
          lines: 90,
        },
        // Cost-recording path — observed stmts/lines 100, branches 83.3.
        "services/orchestrator/src/engine/workflow/subtaskCost.ts": {
          statements: 90,
          branches: 70,
          functions: 90,
          lines: 90,
        },
        // Credential-resolution path — observed (dir aggregate) stmts/lines
        // 88.7, branches 83.2, funcs 91.6. Floors below the weakest member.
        "services/orchestrator/src/engine/credentials/**": {
          statements: 65,
          branches: 45,
          functions: 70,
          lines: 65,
        },
      },
    },
    // P2A-0015: the fixture content under fixtures/acceptance-medium/ is
    // pushed verbatim to the operator-pre-created GitHub repo by the
    // medium acceptance gate. The placeholder vitest test there is meant
    // to run inside the fixture repo's CI, not in the Tanren repo's CI.
    // `.claude/**` excludes Claude Code agent worktrees, which are full
    // checkouts of the repo and would otherwise be discovered (and re-run)
    // by vitest during local development.
    // `**/tests/e2e/**/*.spec.ts` excludes the dashboard's LOCAL-ONLY Playwright
    // smoke (P2B-0001): it imports `@playwright/test` (not a CI dependency) and is
    // run manually via `pnpm test:e2e`, never through the unit `vitest run` gate.
    // `**/tests/e2e/cases/**` excludes the P8b real-resource, real-CREDENTIAL e2e
    // CASES (autonomy-engine §8b): they spend real credits + wall-clock against a
    // live stack and run ONLY via `just e2e`, never in `just fast-check` / public
    // PR CI. The e2e suite's own HARNESS unit tests (`tests/e2e/lib/**/*.test.ts`)
    // are pure (no creds/stack) and DO run here — they pin the gate's verdict
    // logic + the no-mock invariant. The credentialed cases are named `*.e2e.ts`
    // (not `*.test.ts`) so default discovery never picks them up either.
    // `reports/**` excludes Stryker mutation-testing artifacts: Stryker copies
    // the repo into `reports/mutation/.stryker-tmp/sandbox-*` to mutate it, and
    // an interrupted run can leave those copies behind. Without this exclude the
    // unit-test gate would discover and (fail to) run the sandboxed test files.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "fixtures/**",
      ".claude/**",
      "**/tests/e2e/**/*.spec.ts",
      "**/tests/e2e/cases/**",
      "reports/**",
    ],
  },
});
