// Seam conformance suite for the `PercolationOperation` contract
// (`engine/contracts/changePercolation.ts`, autonomy-engine.md §2c
// change-percolation). The reusable behavior spec EVERY percolation operation must
// satisfy — the chain re-integration for one (dependent, ancestor-change). It pins
// the CONTRACT behaviorally through the public `percolate` surface only:
//   - a clean re-base/re-gate ABSORBS the change AND surfaces the new integrated
//     SHA (the termination key) — it NEVER merges unverified;
//   - an ancestor-vs-ancestor conflict on the rebuild HOLDS (routed to P2b), it
//     does NOT discard or absorb;
//   - an irreconcilable re-gate REPLANS (the work stays alive), it does NOT drop
//     or merge.
// Mirrors the SpeculativeIntegrator / DagWalker / VcsProvider suites.

import { describe, expect, it } from "vitest";
import type {
  PercolationDecision,
  PercolationOperation,
  SpeculativeDependent,
} from "../../src/engine/contracts/changePercolation.js";

export const CONF_PROJECT_ID = "project_percolation_conf";
/** A dependent whose single ancestor cleanly re-integrates + re-gates. */
export const CONF_CLEAN_DEPENDENT: SpeculativeDependent = {
  specId: "spec_clean",
  runId: "run_clean",
  speculativeBase: "tanren/integ/spec_clean",
  integratedAncestorShas: { spec_anc: "sha-old" },
};
/** A dependent whose ancestors conflict WITH EACH OTHER on the rebuild (→ held). */
export const CONF_CONFLICT_DEPENDENT: SpeculativeDependent = {
  specId: "spec_conflict",
  runId: "run_conflict",
  speculativeBase: "tanren/integ/spec_conflict",
  integratedAncestorShas: { spec_anc: "sha-old", spec_anc2: "sha-old" },
};
/** A dependent whose re-gate is irreconcilable (→ replanned). */
export const CONF_REPLAN_DEPENDENT: SpeculativeDependent = {
  specId: "spec_replan",
  runId: "run_replan",
  speculativeBase: "tanren/integ/spec_replan",
  integratedAncestorShas: { spec_anc: "sha-old" },
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
  make(): PercolationOperation;
}

export function describeChangePercolationConformance(
  label: string,
  harness: ChangePercolationConformanceHarness,
): void {
  describe(`PercolationOperation conformance: ${label}`, () => {
    it("a clean re-base/re-gate ABSORBS the change + surfaces the new integrated SHA", async () => {
      const op = harness.make();
      const outcome = await op.percolate({
        projectId: CONF_PROJECT_ID,
        dependent: CONF_CLEAN_DEPENDENT,
        decision: confDecision(),
      });
      expect(outcome.result).toBe("absorbed");
      expect(outcome.ancestorSpecId).toBe("spec_anc");
      // The new SHA is surfaced — the next detect's no-op (termination) key.
      expect(outcome.newIntegratedSha).toBe("sha-new");
    });

    it("an ancestor-vs-ancestor conflict on the rebuild HOLDS (not absorbed, not dropped)", async () => {
      const op = harness.make();
      const outcome = await op.percolate({
        projectId: CONF_PROJECT_ID,
        dependent: CONF_CONFLICT_DEPENDENT,
        decision: confDecision(),
      });
      expect(outcome.result).toBe("held");
      // Never recorded/merged on a held rebuild.
      expect(outcome.newIntegratedSha).toBeUndefined();
    });

    it("an irreconcilable re-gate REPLANS (work alive — not dropped, not merged)", async () => {
      const op = harness.make();
      const outcome = await op.percolate({
        projectId: CONF_PROJECT_ID,
        dependent: CONF_REPLAN_DEPENDENT,
        decision: confDecision(),
      });
      expect(outcome.result).toBe("replanned");
      // Never merged unverified — the work is routed back to the planner, alive.
      expect(outcome.newIntegratedSha).toBeUndefined();
    });
  });
}
