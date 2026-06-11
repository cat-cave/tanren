// Seam conformance suite for the `PercolationKickOff` contract
// (`engine/contracts/changePercolation.ts`, autonomy-engine.md §2c change-percolation;
// walker-jj-local-integration-design.md §4). The reusable behavior spec EVERY kick-off
// must satisfy — the FIRST phase of the chain re-integration for one (dependent,
// ancestor-change). It pins the CONTRACT behaviorally through the public `kickOff` surface:
//   - a clean re-resolve RE-EXECUTES the dependent (a real run re-gates the change) and
//     returns the re-execution run id — it does NOT absorb / merge here (absorption is the
//     SETTLE phase, only after that run re-gates clean);
//   - a never-discard base-shift HOLD (a spec-vs-spec assembly conflict surfaces during the
//     LOCAL stack assembly, §4a) PROPAGATES from `reexecute` — under jj-local there is no
//     walk-time host build, so the conflict is no longer detected at kick-off; the hold is a
//     thrown `BaseShiftHeldError` the PercolatingCoordinator catches.

import { describe, expect, it } from "vitest";
import type {
  PercolationDecision,
  PercolationKickOff,
  SpeculativeDependent,
} from "../../src/engine/contracts/changePercolation.js";

export const CONF_PROJECT_ID = "project_percolation_conf";
/** A dependent whose single ancestor cleanly re-resolves (→ re-execution). */
export const CONF_CLEAN_DEPENDENT: SpeculativeDependent = {
  specId: "spec_clean",
  runId: "run_clean",
  speculativeBase: null,
  integratedAncestorShas: { spec_anc: "sha-old" },
  verifiedAncestorShas: { spec_anc: "sha-old" },
  lifecycleState: "building",
  openFindingMaxSeverity: "unaudited",
};
/** A dependent whose base-shift assembly HOLDS (the re-executor throws BaseShiftHeldError). */
export const CONF_CONFLICT_DEPENDENT: SpeculativeDependent = {
  specId: "spec_conflict",
  runId: "run_conflict",
  speculativeBase: null,
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

    it("a never-discard base-shift HOLD propagates from the kick-off (the assembly conflict surfaces)", async () => {
      const op = harness.make();
      // jj-local (§4a): a spec-vs-spec conflict surfaces during the base-shift's LOCAL
      // assembly, so the re-executor throws — the kick-off propagates it (the
      // PercolatingCoordinator catches the BaseShiftHeldError as `held`). NEVER a silent merge.
      await expect(
        op.kickOff({
          projectId: CONF_PROJECT_ID,
          dependent: CONF_CONFLICT_DEPENDENT,
          decision: confDecision(),
          mergedAncestorSpecIds: [],
        }),
      ).rejects.toThrow(/held/iu);
    });
  });
}
