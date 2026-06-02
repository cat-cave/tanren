// Per-implementation invocation of the SpeculativeIntegrator conformance suite.
// The suite runs against an in-memory fake integrator (a test fixture — it lives
// HERE, under tests/, never in src/) proving the suite pins the CONTRACT, not a
// pg/VcsProvider transport. The pg-backed `PgSpeculativeIntegrator` is exercised
// against a fake VcsProvider + a fake pool in `dagSpeculativeIntegratorPg.test.ts`
// (its DB resolution is integration-tested against the live stack).

import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../../src/engine/contracts/speculativeIntegrator.js";
import {
  CONF_CONFLICT_ANCESTOR,
  describeSpeculativeIntegratorConformance,
} from "./speculativeIntegratorConformance.js";

/** In-memory contract impl: clean unless an ancestor matches the conflict id. */
class InMemorySpeculativeIntegrator implements SpeculativeIntegrator {
  async buildIntegration(input: BuildSpeculativeIntegrationInput): Promise<IntegrationOutcome> {
    const integrationBranch = `tanren/integ/${input.dependentSpecId}`;
    const merged: string[] = [];
    for (const specId of input.unmergedAncestorSpecIds) {
      if (specId === CONF_CONFLICT_ANCESTOR) {
        return {
          outcome: "conflict",
          integrationBranch,
          conflictBetween: { specId, otherSpecId: merged.at(-1) ?? "" },
          message: "conflict",
        };
      }
      merged.push(specId);
    }
    return { outcome: "integrated", integrationBranch, message: "ok" };
  }
}

describeSpeculativeIntegratorConformance("InMemorySpeculativeIntegrator", {
  make: () => new InMemorySpeculativeIntegrator(),
});
