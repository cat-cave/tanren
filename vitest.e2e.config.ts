import { defineConfig } from "vitest/config";

// P8b — the real-resource e2e gate's vitest config (autonomy-engine §8b).
//
// Used ONLY by `just e2e`. It includes the credentialed CASES
// (tests/e2e/cases/**/*.e2e.ts) that the default config (vitest.config.ts)
// deliberately EXCLUDES from `just fast-check` / public PR CI because they spend
// real credits + wall-clock against a live stack. The cases are named `*.e2e.ts`
// so default discovery never picks them up; this config opts them in explicitly.
//
// No coverage thresholds here: the e2e gate proves the assembled system does real
// work end-to-end against real resources; the unit/coverage gate is `just ci`.
// The `@tanren/db` alias mirrors the default config so the harness can read the
// real persisted artifacts through the package's public entry.
export default defineConfig({
  resolve: {
    alias: {
      "@tanren/db": new URL("./db/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["tests/e2e/cases/**/*.e2e.ts"],
    // The credentialed run drives a live stack: give each case room and never
    // bail early — every tier proof should report its own verdict.
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
