// Seam conformance suite for the `PercolationKickOff` contract
// (`engine/contracts/changePercolation.ts`, autonomy-engine.md §2c
// change-percolation). The reusable behavior spec EVERY kick-off must satisfy — the
// FIRST phase of the chain re-integration for one (dependent, ancestor-change). It
// pins the CONTRACT behaviorally through the public `kickOff` surface only:
//   - a clean rebuild RE-EXECUTES the dependent (a real run re-gates the change) and
//     returns the re-execution run id — it does NOT absorb / merge here (absorption
//     is the SETTLE phase, only after that run re-gates clean);
//   - an ancestor-vs-ancestor conflict on the rebuild HOLDS (routed to the P2b
//     resolver), with NO re-execution kicked off and the dependent untouched.
// Mirrors the SpeculativeIntegrator / DagWalker / VcsProvider suites.

import { describe, expect, it } from "vitest";
import type {
  PercolationDecision,
  PercolationKickOff,
  SpeculativeDependent,
} from "../../src/engine/contracts/changePercolation.js";

export const CONF_PROJECT_ID = "project_percolation_conf";
/** A dependent whose single ancestor cleanly re-integrates (→ re-execution). */
export const CONF_CLEAN_DEPENDENT: SpeculativeDependent = {
  specId: "spec_clean",
  runId: "run_clean",
  speculativeBase: "tanren/integ/spec_clean",
  integratedAncestorShas: { spec_anc: "sha-old" },
  verifiedAncestorShas: { spec_anc: "sha-old" },
  lifecycleState: "building",
  openFindingMaxSeverity: "unaudited",
};
/** A dependent whose ancestors conflict WITH EACH OTHER on the rebuild (→ held). */
export const CONF_CONFLICT_DEPENDENT: SpeculativeDependent = {
  specId: "spec_conflict",
  runId: "run_conflict",
  speculativeBase: "tanren/integ/spec_conflict",
  integratedAncestorShas: { spec_anc: "sha-old", spec_anc2: "sha-old" },
  verifiedAncestorShas: { spec_anc: "sha-old", spec_anc2: "sha-old" },
  lifecycleState: "building",
  openFindingMaxSeverity: "unaudited",
};

/** The immediate decision the suite drives (ancestor SHA advanced to the new sha). */
export function confDecision(): PercolationDecision {
  return {
    ancestorSpecId: "spec_anc",
    promptness: "immediate",
    fromSha: "sha-old",
    toSha: "sha-new",
    immediateSeverity: "P0",
  };
}

export interface ChangePercolationConformanceHarness {
  make(): PercolationKickOff;
}

export function describeChangePercolationConformance(
  label: string,
  harness: ChangePercolationConformanceHarness,
): void {
  describe(`PercolationKickOff conformance: ${label}`, () => {
    it("a clean rebuild RE-EXECUTES the dependent (returns the re-exec run id) — not absorbed here", async () => {
      const op = harness.make();
      const outcome = await op.kickOff({
        projectId: CONF_PROJECT_ID,
        dependent: CONF_CLEAN_DEPENDENT,
        decision: confDecision(),
        mergedAncestorSpecIds: [],
      });
      expect(outcome.result).toBe("reexecuting");
      expect(outcome.ancestorSpecId).toBe("spec_anc");
      expect(typeof outcome.reexecRunId).toBe("string");
      expect(outcome.reexecRunId).not.toBe("");
    });

    it("an ancestor-vs-ancestor conflict on the rebuild HOLDS (no re-execution)", async () => {
      const op = harness.make();
      const outcome = await op.kickOff({
        projectId: CONF_PROJECT_ID,
        dependent: CONF_CONFLICT_DEPENDENT,
        decision: confDecision(),
        mergedAncestorSpecIds: [],
      });
      expect(outcome.result).toBe("held");
      // Never re-executed on a held rebuild (the ancestors conflict first).
      expect(outcome.reexecRunId).toBeUndefined();
    });
  });
}
