// Drives the PercolationKickOff conformance suite against the PRODUCTION
// `PercolatingKickOff` (autonomy-engine.md §2c; walker-jj-local-integration-design.md §4),
// composing in-memory fixtures of its two seams (the ancestor-stack resolver + the
// never-discard base-shift re-executor). This proves the real kick-off class — not a
// parallel fake — honors the §4 contract: re-execute-on-clean-resolve, propagate the
// base-shift HOLD (the assembly conflict surfaces at the re-executor, not at kick-off). The
// fixtures live HERE, never src/.

import { BaseShiftHeldError } from "../../src/engine/dag/baseShiftCoordinator.js";
import type { PercolationDecision, SpeculativeDependent } from "../../src/engine/contracts/changePercolation.js";
import type { AncestorStack } from "../../src/engine/dag/ancestorStack.js";
import {
  PercolatingKickOff,
  type PercolationReexecutor,
  type PercolationStackResolver,
} from "../../src/engine/dag/percolationOperation.js";
import { CONF_CONFLICT_DEPENDENT, describeChangePercolationConformance } from "./changePercolationConformance.js";

// Resolve each unmerged ancestor to its real PR-head branch + run id (DAG order preserved).
class ConformanceStackResolver implements PercolationStackResolver {
  async resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<{ specId: string; runId: string; branch: string }>> {
    return input.unmergedAncestorSpecIds.map((specId) => ({
      specId,
      runId: `run_${specId}`,
      branch: `tanren/run/${specId}`,
    }));
  }
}

// An in-memory re-executor: returns a deterministic re-execution run id, EXCEPT for the
// well-known multi-ancestor dependent whose LOCAL assembly conflicts — it throws a
// `BaseShiftHeldError` (the never-discard hold the jj-local base shift surfaces).
class ConformanceReexecutor implements PercolationReexecutor {
  async reexecute(input: {
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    ancestorStack: AncestorStack;
    nonSpeculative: boolean;
  }): Promise<{ reexecRunId: string; decision: "rebased_clean" }> {
    if (input.dependent.specId === CONF_CONFLICT_DEPENDENT.specId) {
      throw new BaseShiftHeldError("rebase", "ancestors conflict during the local stack assembly");
    }
    return { reexecRunId: `reexec_${input.dependent.specId}`, decision: "rebased_clean" };
  }
}

describeChangePercolationConformance("PercolatingKickOff (in-memory seams)", {
  make: () =>
    new PercolatingKickOff({
      stackResolver: new ConformanceStackResolver(),
      reexecutor: new ConformanceReexecutor(),
    }),
});
