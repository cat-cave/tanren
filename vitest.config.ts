import { MergifyReporter } from "@mergifyio/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tanren/db": new URL("./db/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    reporters: ["default", new MergifyReporter()],
    // P3-0029 observability: coverage thresholds for WORKFLOW-CRITICAL modules
    // only — the planner-feedback loop stages, the answerer reasoning paths
    // (planner/checker/auditor), the cost-recording path, and the
    // credential-resolution path. These are per-glob ratchets set at or just
    // BELOW the measured coverage (so the gate does not go red) to guard
    // against regressions in the modules an autonomous run depends on. There is
    // deliberately NO global threshold (that would couple the whole suite to
    // these numbers). Observed coverage at authoring time is noted per glob.
    coverage: {
      provider: "v8",
      // Only the critical modules are instrumented; everything else is
      // excluded so the thresholds key off these files alone.
      include: [
        "services/orchestrator/src/engine/workflow/subtaskStages.ts",
        "services/orchestrator/src/engine/workflow/subtaskCost.ts",
        "services/orchestrator/src/engine/workflow/auditor/**",
        "services/orchestrator/src/engine/workflow/checker/**",
        "services/orchestrator/src/engine/workflow/planner/**",
        "services/orchestrator/src/engine/credentials/**"
      ],
      thresholds: {
        // Answerer reasoning paths — observed 100/100/100. Floor well below.
        "services/orchestrator/src/engine/workflow/auditor/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90
        },
        "services/orchestrator/src/engine/workflow/checker/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90
        },
        "services/orchestrator/src/engine/workflow/planner/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90
        },
        // Loop stages — observed stmts/lines 100, branches 73.9, funcs 100.
        "services/orchestrator/src/engine/workflow/subtaskStages.ts": {
          statements: 90,
          branches: 60,
          functions: 90,
          lines: 90
        },
        // Cost-recording path — observed stmts/lines 100, branches 83.3.
        "services/orchestrator/src/engine/workflow/subtaskCost.ts": {
          statements: 90,
          branches: 70,
          functions: 90,
          lines: 90
        },
        // Credential-resolution path — observed (dir aggregate) stmts/lines
        // 88.7, branches 83.2, funcs 91.6. Floors below the weakest member.
        "services/orchestrator/src/engine/credentials/**": {
          statements: 65,
          branches: 45,
          functions: 70,
          lines: 65
        }
      }
    },
    // P2A-0015: the fixture content under fixtures/acceptance-medium/ is
    // pushed verbatim to the operator-pre-created GitHub repo by the
    // medium acceptance gate. The placeholder vitest test there is meant
    // to run inside the fixture repo's CI, not in the Tanren repo's CI.
    // `.claude/**` excludes Claude Code agent worktrees, which are full
    // checkouts of the repo and would otherwise be discovered (and re-run)
    // by vitest during local development.
    // `**/tests/e2e/**` excludes the dashboard's LOCAL-ONLY Playwright smoke
    // (P2B-0001): it imports `@playwright/test` (not a CI dependency) and is run
    // manually via `pnpm test:e2e`, never through the unit `vitest run` gate.
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**", ".claude/**", "**/tests/e2e/**"]
  }
});
