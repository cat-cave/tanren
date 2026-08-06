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
// `integrationLifecycleModel.test.ts`'s `keeps all schema exports aligned and
// under the architecture line cap` case asserts each `db/src/schema*.ts` is
// `split("\n").length <= 500`. `db/src/schemaCore.ts` sits at EXACTLY 500 in the
// real tree; Stryker's sandbox copy re-writes the file with a trailing newline,
// making the split length 501 and failing the initial (un-mutated) dry run before
// any mutant is tested. Environmental to the sandbox — it mutates no source and
// the real tree is still gated by `scripts/check-architecture.mjs` plus the normal
// `just`/CI suite — so it is excluded from the mutation run only, matching the two
// exclusions above.
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
      "**/tests/integrationLifecycleModel.test.ts",
    ],
  },
});
