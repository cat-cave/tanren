// The production change-percolation KICK-OFF operation (autonomy-engine.md §2c
// "Change-percolation — NOT discard"): for ONE (dependent, ancestor-change) it
// rebuilds the speculative integration against the ancestor's NEW state (reuse the
// P2c-1 SpeculativeIntegrator), re-bases the dependent onto it, and RE-EXECUTES the
// dependent through a REAL run so its OWN gate + checker + auditor genuinely re-run
// against the percolated change. It is the `PercolationKickOff` seam the
// PercolatingCoordinator drives.
//
// It does NOT verify or absorb here — the re-execution settles (absorb / replan) on
// a LATER coordinator pass once its gate+checker+auditor terminate (never merge
// unverified; never record the absorbed key on a bare re-base). The re-base seam
// keeps the dependent's OWN branch/work as the base — it is re-pointed, not reset.
//
// Flow:
//   1. REBUILD the integration (SpeculativeIntegrator). An ancestor-vs-other-ancestor
//      conflict ⇒ `held` (routed to P2b; retried) — the dependent untouched.
//   2. RE-BASE the dependent onto the rebuilt integration (update `speculative_base`
//      + the build-base `integrated_ancestor_shas`).
//   3. RE-ENQUEUE the dependent for re-execution (the DagWalker run path) and write
//      the IN-FLIGHT marker (the loop guard + the settle handle). Returns
//      `reexecuting` with the re-execution run id.

import {
  type PercolationDecision,
  type PercolationKickOff,
  type PercolationKickOffOutcome,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";
import type { SpeculativeIntegrator } from "../contracts/speculativeIntegrator.js";

/**
 * Re-points the dependent onto the rebuilt integration branch (update
 * `speculative_base` + the build-base `integrated_ancestor_shas` to the ancestor's
 * new head), then RE-ENQUEUES the dependent for a real re-execution (the DagWalker
 * createQueuedRunFromSpec path — gate/checker/auditor run INSIDE that run, no second
 * runner), keeping the dependent's OWN branch/work as the base. Writes the in-flight
 * marker so the coordinator's settle phase resolves it. A SEAM (not inlined) so the
 * kick-off is conformance-tested without a DB or worker.
 *
 * Returns the re-execution run id. The production impl moves the spec back to a
 * re-runnable status and creates the speculative run; a re-enqueue that races a spec
 * already re-running is idempotent (returns the existing in-flight re-exec run id),
 * so a notification storm cannot kick off duplicate re-executions.
 */
export interface PercolationReexecutor {
  reexecute(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
  }): Promise<{ reexecRunId: string }>;
}

export interface PercolatingKickOffDeps {
  integrator: SpeculativeIntegrator;
  reexecutor: PercolationReexecutor;
}

export class PercolatingKickOff implements PercolationKickOff {
  constructor(private readonly deps: PercolatingKickOffDeps) {}

  async kickOff(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
  }): Promise<PercolationKickOffOutcome> {
    const { projectId, dependent, decision } = input;

    // 1. Rebuild the integration branch against the ancestor's NEW state. The
    //    integrator stacks EVERY ancestor (re-resolving each one's latest branch),
    //    so the rebuilt base reflects the upstream change. An A-vs-other conflict
    //    surfaces here, early — `held` (routed to P2b; retried), dependent untouched.
    const integration = await this.deps.integrator.buildIntegration({
      projectId,
      dependentSpecId: dependent.specId,
      unmergedAncestorSpecIds: Object.keys(dependent.integratedAncestorShas),
    });
    if (integration.outcome === "conflict") {
      return {
        result: "held",
        ancestorSpecId: decision.ancestorSpecId,
        reason: integration.message,
      };
    }

    // 2 + 3. Re-base the dependent onto the rebuilt integration AND re-execute it
    //        through a REAL run (its gate+checker+auditor re-run against the change),
    //        writing the in-flight marker. Absorption is deferred to the settle of a
    //        later pass — NEVER merge unverified, NEVER absorb on a bare re-base.
    const { reexecRunId } = await this.deps.reexecutor.reexecute({
      projectId,
      dependent,
      decision,
      integrationBranch: integration.integrationBranch,
      ancestorHeadShas: integration.ancestorHeadShas,
    });
    return { result: "reexecuting", ancestorSpecId: decision.ancestorSpecId, reexecRunId };
  }
}
