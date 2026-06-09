// Guard for the greenfield scaffold writer's pinned `.tanren/ci.yml` example.
//
// The v25 live bug: #438 told the scaffold writer the 3-tier MAPPING in prose but
// gave no concrete shape, so the writer authored each tier as an OBJECT with an
// inline `when` (omitting the top-level `when`) — which fails CiConfigV1 validation
// (`tiers.fast: expected array, received object; when: expected record, received
// undefined`) and crash-looped the worker. The fix pins SCAFFOLD_CI_CONFIG_EXAMPLE,
// a concrete correct-shape example the writer copies verbatim.
//
// This test closes the gap #438 left — #438 tested STRUCTURE, not whether it PARSES: it
// round-trips the pinned example through the REAL CiConfigV1 schema (`resolveCiConfig`)
// and asserts the 3 tiers + the separate `when` mapping. If the example ever drifts
// to a shape the gate parser/schema rejects, this fails before a live apex run does.

import { describe, expect, it } from "vitest";
import { resolveCiConfig } from "../src/engine/ci/index.js";
import { SCAFFOLD_CI_CONFIG_EXAMPLE } from "../src/engine/forge/interview/scaffoldCiConfig.js";

describe("SCAFFOLD_CI_CONFIG_EXAMPLE · the greenfield .tanren/ci.yml the writer copies", () => {
  it("PARSES via resolveCiConfig (correct CiConfigV1 shape — the v25 fix)", () => {
    // Round-trips through the REAL CiConfigV1 schema without throwing.
    const config = resolveCiConfig(SCAFFOLD_CI_CONFIG_EXAMPLE);
    expect(config.version).toBe(1);

    // Exactly the 3 tiers, each an ARRAY of `{ name, run }` steps (NOT a tier object).
    expect(Object.keys(config.tiers).sort()).toEqual(["fast", "merge", "slow"]);
    expect(config.tiers.fast?.map((s) => s.name)).toEqual(["lint", "typecheck"]);
    for (const tier of Object.values(config.tiers)) {
      expect(Array.isArray(tier)).toBe(true);
      for (const step of tier) {
        expect(typeof step.name).toBe("string");
        expect(typeof step.run).toBe("string");
      }
    }

    // The SEPARATE top-level `when` maps each declared tier to its lifecycle point.
    expect(config.when.fast).toEqual(["per_iteration"]);
    expect(config.when.slow).toEqual(["pre_audit"]);
    expect(config.when.merge).toEqual(["pre_merge"]);

    // The #438 intent survives: NO tests in the fast tier; JUnit on slow + merge.
    expect((config.tiers.fast ?? []).some((s) => /test/u.test(s.run))).toBe(false);
    for (const tierName of ["slow", "merge"] as const) {
      const testStep = (config.tiers[tierName] ?? []).find((s) => s.name === "test");
      expect(testStep?.run).toContain("--reporter=junit");
      expect(testStep?.run).toContain("--outputFile=reports/junit.xml");
    }
  });
});
