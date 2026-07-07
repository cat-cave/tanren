import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

// Vitest config used ONLY by the scoped Stryker mutation runs (stryker.*.mjs).
// It extends the repo's base config and adds test exclusions for the drift /
// lint gates that misbehave inside Stryker's COPIED SANDBOX
// (reports/mutation/.stryker-tmp-*/sandbox-*).
//
// `scripts/gen-dashboard-types.test.ts` is a DRIFT GATE: its last case spawns
// `node scripts/gen-dashboard-types.mjs --check` and asserts the subprocess
// emits no drift. Under Stryker the spawned subprocess re-derives the dashboard
// types from the sandbox copy and reports drift against the committed file,
// which fails Stryker's initial (un-mutated) dry run before any mutant is even
// tested. Environmental to the sandbox, exercises no mutated Forge source, and
// already enforced by the normal `just`/CI suite.
//
// `scripts/lint/env-read-whitelist.test.ts`'s `PASSES the real repo tree` case
// scans `services/**/*.{ts,tsx}` for bare `process.env.X` reads. Stryker
// INSTRUMENTS every mutated file with `process.env.__STRYKER_ACTIVE_MUTANT__`
// reads — its runtime mutant-toggle mechanism — which the whitelist scan
// (correctly) sees as un-allowlisted `process.env` reads. The MORE files a
// cluster mutates, the MORE injected reads land in the sandbox, so the failure
// grew with the codebase (June 8 pre-repositories-expansion runs passed; June
// 15+ runs fail). The whitelist stays Stryker-agnostic and the test is excluded
// from the mutation run only, matching the gen-dashboard-types doctrine. The
// real repo tree is still gated by the normal `just`/CI suite.
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
      "**/scripts/lint/env-read-whitelist.test.ts",
    ],
  },
});
