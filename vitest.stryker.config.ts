import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

// Vitest config used ONLY by the scoped Stryker mutation runs (stryker.*.mjs).
// It extends the repo's base config and adds one extra test exclusion.
//
// `scripts/gen-dashboard-types.test.ts` is a DRIFT GATE: its last case spawns
// `node scripts/gen-dashboard-types.mjs --check` and asserts the subprocess
// emits no drift. Under Stryker the suite runs inside a COPIED sandbox
// (reports/mutation/.stryker-tmp-*/sandbox-*); the spawned subprocess re-derives
// the dashboard types from the sandbox copy and reports drift against the
// committed file, which fails Stryker's initial (un-mutated) dry run before any
// mutant is even tested. The gate is environmental to the sandbox, exercises no
// mutated Forge source, and is already enforced by the normal `just`/CI suite,
// so it is excluded from the mutation run only. No mutated module loses
// coverage by dropping it.
export default mergeConfig(baseConfig, {
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "fixtures/**",
      ".claude/**",
      "**/tests/e2e/**",
      "reports/**",
      "**/scripts/gen-dashboard-types.test.ts",
    ],
  },
});
