// Drives the PercolationKickOff conformance suite against the PRODUCTION
// `PercolatingKickOff` (autonomy-engine.md §2c), composing in-memory fixtures of its
// two seams (the SpeculativeIntegrator rebuild + the re-executor). This proves the
// real kick-off class — not a parallel fake — honors the §2c contract:
// re-execute-on-clean-rebuild, hold-on-rebuild-conflict. The fixtures live HERE,
// never src/.

import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../../src/engine/contracts/speculativeIntegrator.js";
import type { PercolationDecision, SpeculativeDependent } from "../../src/engine/contracts/changePercolation.js";
import { PercolatingKickOff, type PercolationReexecutor } from "../../src/engine/dag/percolationOperation.js";
import { CONF_CONFLICT_DEPENDENT, describeChangePercolationConformance } from "./changePercolationConformance.js";

// The integrator returns `conflict` for the well-known multi-ancestor dependent
// (its rebuild surfaces an ancestor-vs-ancestor conflict), else `integrated`.
class ConformanceIntegrator implements SpeculativeIntegrator {
  async buildIntegration(input: BuildSpeculativeIntegrationInput): Promise<IntegrationOutcome> {
    const integrationBranch = `tanren/integ/${input.dependentSpecId}`;
    if (input.dependentSpecId === CONF_CONFLICT_DEPENDENT.specId) {
      return {
        outcome: "conflict",
        integrationBranch,
        ancestorHeadShas: {},
        conflictBetween: {
          specId: input.unmergedAncestorSpecIds[1] ?? "",
          otherSpecId: input.unmergedAncestorSpecIds[0] ?? "",
        },
        message: "ancestors conflict",
      };
    }
    return {
      outcome: "integrated",
      integrationBranch,
      ancestorHeadShas: Object.fromEntries(input.unmergedAncestorSpecIds.map((id) => [id, `sha-${id}`])),
      message: "ok",
    };
  }
}

// An in-memory re-executor: returns a deterministic re-execution run id.
class ConformanceReexecutor implements PercolationReexecutor {
  async reexecute(input: {
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
  }): Promise<{ reexecRunId: string }> {
    return { reexecRunId: `reexec_${input.dependent.specId}` };
  }
}

describeChangePercolationConformance("PercolatingKickOff (in-memory seams)", {
  make: () =>
    new PercolatingKickOff({
      integrator: new ConformanceIntegrator(),
      reexecutor: new ConformanceReexecutor(),
    }),
});
