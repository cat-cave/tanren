// Seam conformance suite for the SpeculativeIntegrator contract
// (`engine/contracts/speculativeIntegrator.ts`, autonomy-engine.md §2c). The
// reusable behavior spec every integrator must satisfy — the surface that builds a
// dependent's speculative integration branch (the dynamic base). It pins the
// CONTRACT behaviorally through the public `buildIntegration` surface only: a
// clean build returns `integrated` with the integration branch ref; an
// ancestor-vs-ancestor conflict returns `conflict` naming the pair (it does NOT
// throw — the walker routes the pair to the P2b resolver). Mirrors the Allocator /
// DagWalker / VcsProvider suites.

import { describe, expect, it } from "vitest";
import type { SpeculativeIntegrator } from "../../src/engine/contracts/speculativeIntegrator.js";

/** Well-known inputs the harnesses prime + the suite asserts against. */
export const CONF_PROJECT_ID = "project_integ_conf";
export const CONF_DEPENDENT = "spec_dependent";
/** Two ancestors that integrate cleanly. */
export const CONF_CLEAN_ANCESTORS = ["spec_anc_a", "spec_anc_b"];
/** An ancestor that conflicts WITH ANOTHER ancestor (its id triggers the conflict). */
export const CONF_CONFLICT_ANCESTOR = "spec_anc_conflict";

export interface SpeculativeIntegratorConformanceHarness {
  /** Build a fresh integrator wired for the conformance scenario. */
  make(): SpeculativeIntegrator;
}

export function describeSpeculativeIntegratorConformance(
  label: string,
  harness: SpeculativeIntegratorConformanceHarness,
): void {
  describe(`SpeculativeIntegrator conformance: ${label}`, () => {
    it("a clean build returns integrated with the integration branch ref", async () => {
      const integrator = harness.make();
      const result = await integrator.buildIntegration({
        projectId: CONF_PROJECT_ID,
        dependentSpecId: CONF_DEPENDENT,
        unmergedAncestorSpecIds: CONF_CLEAN_ANCESTORS,
      });
      expect(result.outcome).toBe("integrated");
      expect(typeof result.integrationBranch).toBe("string");
      expect(result.integrationBranch.length).toBeGreaterThan(0);
    });

    it("an ancestor-vs-ancestor conflict returns conflict naming the pair (not a throw)", async () => {
      const integrator = harness.make();
      const result = await integrator.buildIntegration({
        projectId: CONF_PROJECT_ID,
        dependentSpecId: CONF_DEPENDENT,
        unmergedAncestorSpecIds: [CONF_CLEAN_ANCESTORS.at(0)!, CONF_CONFLICT_ANCESTOR],
      });
      expect(result.outcome).toBe("conflict");
      expect(result.conflictBetween?.specId).toBe(CONF_CONFLICT_ANCESTOR);
      // The other side is the previously-integrated ancestor.
      expect(result.conflictBetween?.otherSpecId).toBe(CONF_CLEAN_ANCESTORS[0]);
    });
  });
}
