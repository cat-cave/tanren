// The production change-percolation KICK-OFF operation (autonomy-engine.md §2c
// "Change-percolation — NOT discard"): for ONE (dependent, ancestor-change) it
// rebuilds the speculative integration against the ancestor's NEW state (reuse the
// SpeculativeIntegrator), re-bases the dependent onto it, and RE-EXECUTES the
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
//      conflict ⇒ `held` (routed to the conflict resolver; retried) — the dependent untouched.
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
    /**
     * The re-execution re-bases onto plain `default_branch` and is genuinely
     * NON-speculative — set when EVERY ancestor has merged (the unmerged subset is
     * empty). The re-exec run carries NO `speculative_base` (NULL) + NO build-base
     * ancestor SHAs, so it is a real run against main (mirrors a non-speculative
     * run), not a speculative one stacked on an integration ref.
     */
    nonSpeculative: boolean;
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
    mergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<PercolationKickOffOutcome> {
    const { projectId, dependent, decision } = input;

    // DROP the merged ancestors from the speculative stack (§2c "ancestor-merged →
    // proactive re-base"): a merged ancestor's content arrives via FRESH MAIN (the
    // integrator resets the ephemeral ref to default_branch first), so only the
    // UNMERGED ancestors are stacked. When EVERY ancestor has merged this subset is
    // empty and the re-base is onto plain default_branch — a genuinely
    // NON-speculative re-execution.
    const merged = new Set(input.mergedAncestorSpecIds);
    const unmergedAncestorSpecIds = Object.keys(dependent.integratedAncestorShas).filter((id) => !merged.has(id));
    const nonSpeculative = unmergedAncestorSpecIds.length === 0;

    // 1. Rebuild the integration branch against the UNMERGED ancestors' NEW state.
    //    The integrator resets the ephemeral ref to default_branch then stacks each
    //    unmerged ancestor (re-resolving its latest branch), so the rebuilt base
    //    reflects fresh main + the still-pending upstream work. An A-vs-other
    //    conflict surfaces here, early — `held` (routed to the conflict resolver; retried), dependent
    //    untouched. With an empty unmerged set the integrator resets the ref to plain
    //    default_branch (no ancestor stacked); the re-exec then drops the base to NULL.
    const integration = await this.deps.integrator.buildIntegration({
      projectId,
      dependentSpecId: dependent.specId,
      unmergedAncestorSpecIds,
    });
    if (integration.outcome === "conflict") {
      return {
        result: "held",
        ancestorSpecId: decision.ancestorSpecId,
        reason: integration.message,
      };
    }

    // 2 + 3. Re-base the dependent onto the rebuilt integration (or onto plain main
    //        when non-speculative) AND re-execute it through a REAL run (its
    //        gate+checker+auditor re-run against the change), writing the in-flight
    //        marker. Absorption is deferred to the settle of a later pass — NEVER
    //        merge unverified, NEVER absorb on a bare re-base.
    const { reexecRunId } = await this.deps.reexecutor.reexecute({
      projectId,
      dependent,
      decision,
      integrationBranch: integration.integrationBranch,
      ancestorHeadShas: integration.ancestorHeadShas,
      nonSpeculative,
    });
    return { result: "reexecuting", ancestorSpecId: decision.ancestorSpecId, reexecRunId };
  }
}
