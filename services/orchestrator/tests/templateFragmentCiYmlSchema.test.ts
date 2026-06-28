// CURATED-STACK CI.YML SCHEMA REGRESSION (task #80 — apex v62 halt). Pins, by name,
// that EVERY curated `CuratedTemplate` (registry/curated.ts) composes a
// `.tanren/ci.yml` that PARSES against the `CiConfigV1` zod schema (ci/schema.ts).
//
// THE V62 HALT: the writer hit the gate's tanren-ci-config validate step with
//   `invalid tanren-ci.yml: tiers.fast: Invalid input: expected array`
// because base/ emitted `tiers.tier-1/tier-2/tier-3` instead of the schema's
// required `fast`/`slow`/(merge) vocabulary. The writer cannot fix an upstream
// fragment from inside the workspace — it burned its whole Codex window trying.
// The matrix-coverage + isolation harnesses now parse every composed ci.yml against
// CiConfigV1 (templateFragmentMatrixCoverage.test.ts assertion #7,
// templateFragmentIsolation.test.ts assertion (f)). This file is the NAMED
// regression pin: one `it()` per curated entry, so a future regression surfaces
// with the curated entry's id in the failure message, not buried under a matrix
// slug. The dedicated entries here are intentionally redundant with the matrix
// harness — the matrix is the catch-all, this file is the proof the v62 halt
// cannot recur for any registered stack.

import { describe, expect, it } from "vitest";
import { resolveCiConfig } from "../src/engine/ci/resolve.js";
import { composeTemplate, CURATED_TEMPLATES, loadFragmentLibrary } from "../src/engine/templates/index.js";

describe("template-fragment ci.yml schema — v62 halt regression (task #80)", () => {
  for (const curated of CURATED_TEMPLATES) {
    it(`curated entry "${curated.id}" composes a .tanren/ci.yml that parses against CiConfigV1`, async () => {
      const library = loadFragmentLibrary();
      const vfs = await composeTemplate(curated.config, library);
      const ci = vfs.read(".tanren/ci.yml");

      // The exact parse the in-loop gate runs (workflow/gate/resolveGateConfig.ts →
      // ci/resolve.ts → CiConfigV1.safeParse). If this throws, the gate's
      // tanren-ci-config validate step would FAIL the same way apex v62 did.
      const config = resolveCiConfig(ci);

      // Anchoring pins so a future schema/template drift surfaces with the broken
      // shape named explicitly (rather than only "parse failed").
      expect(Object.keys(config.tiers).sort()).toEqual(["fast", "merge", "slow"]);
      expect(config.when["fast"]).toContain("per_iteration");
      expect(config.when["slow"]).toContain("pre_audit");
      expect(config.when["merge"]).toContain("pre_merge");
    });
  }
});
