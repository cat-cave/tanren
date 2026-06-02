// Drives the PercolationOperation conformance suite against the PRODUCTION
// `PercolatingOperation` (autonomy-engine.md §2c), composing in-memory fixtures of
// its three seams (the SpeculativeIntegrator rebuild, the re-base/re-gate, the SHA
// recorder). This proves the real operation class — not a parallel fake — honors
// the §2c contract: absorb-on-clean (+ record the SHA), hold-on-rebuild-conflict,
// replan-on-irreconcilable. The fixtures live HERE, never src/.

import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../../src/engine/contracts/speculativeIntegrator.js";
import type { SpeculativeDependent } from "../../src/engine/contracts/changePercolation.js";
import { PercolatingOperation, type PercolationReGate } from "../../src/engine/dag/percolationOperation.js";
import {
  CONF_CONFLICT_DEPENDENT,
  CONF_REPLAN_DEPENDENT,
  describeChangePercolationConformance,
} from "./changePercolationConformance.js";

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

// The re-gate is irreconcilable for the well-known replan dependent, else clean.
class ConformanceReGate implements PercolationReGate {
  async rebaseAndReGate(input: {
    dependent: SpeculativeDependent;
  }): Promise<{ outcome: "absorbed" | "replanned"; viaResolver: boolean; reason?: string }> {
    if (input.dependent.specId === CONF_REPLAN_DEPENDENT.specId) {
      return { outcome: "replanned", viaResolver: true, reason: "irreconcilable" };
    }
    return { outcome: "absorbed", viaResolver: false };
  }
}

describeChangePercolationConformance("PercolatingOperation (in-memory seams)", {
  make: () =>
    new PercolatingOperation({
      integrator: new ConformanceIntegrator(),
      reGate: new ConformanceReGate(),
      recordIntegratedSha: async () => {
        /* in-memory: recording is a no-op fixture; the production impl writes pg. */
      },
    }),
});
