// The production change-percolation OPERATION (autonomy-engine.md §2c
// "Change-percolation — NOT discard"): the chain re-integration for ONE
// (dependent, ancestor-change), composing the P2c-1 SpeculativeIntegrator (rebuild)
// + the P2a/P2b re-base/re-gate/resolver (verify) + the run-SHA recorder. It is
// the `PercolationOperation` seam the PercolatingCoordinator drives.
//
// Flow (NEVER rollback, NEVER discard, NEVER merge unverified):
//   1. REBUILD the dependent's speculative integration branch against the
//      ancestor's NEW state (reuse PgSpeculativeIntegrator). An ancestor-vs-other-
//      ancestor conflict on the rebuild ⇒ `held` (routed to the P2b resolver as in
//      P2c-1; retried on the next notification) — the dependent's work is untouched.
//   2. RE-BASE + RE-GATE the dependent against the rebuilt integration (reuse the
//      P2a/P2b re-gate; on a semantic break the resolver runs in UPSTREAM-CHANGE
//      mode — apply A's change INTO B keeping B intact — then re-gates again).
//        - clean re-gate            ⇒ record the new integrated SHA + `absorbed`
//          (B's work preserved AND verified against the new base).
//        - irreconcilable / failed  ⇒ `replanned` (B routed back to the planner
//          WITH A's change as context — the work stays ALIVE, never dropped, never
//          merged on a stale or unverified base).
// Recording the new SHA on `absorbed` is the TERMINATION key: the next detect with
// the same SHA is a no-op, so a settled chain never re-percolates.

import {
  type PercolationDecision,
  type PercolationOperation,
  type PercolationOutcome,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";
import type { SpeculativeIntegrator } from "../contracts/speculativeIntegrator.js";

/**
 * The re-base + re-gate of a dependent against its rebuilt speculative integration
 * — reusing the P2a up-to-date/auto-rebase + the P2b resolved-tree re-gate (the
 * resolver runs in UPSTREAM-CHANGE mode on a break). This is a SEAM (not inlined)
 * so the operation is conformance-tested without a runner, and the production
 * wiring supplies the runner-backed impl that drives the dependent's re-execution.
 *
 * Returns the verification verdict of absorbing the upstream change into the
 * dependent against the rebuilt base:
 *   - `absorbed`     — re-base + re-gate clean (optionally via the resolver).
 *   - `replanned`    — irreconcilable (resolver said so) or the re-gate failed:
 *                      the dependent was routed back to the planner WITH the
 *                      ancestor's change as context. NEVER merged, NEVER dropped.
 */
export interface PercolationReGate {
  rebaseAndReGate(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    integrationBranch: string;
  }): Promise<{ outcome: "absorbed" | "replanned"; viaResolver: boolean; reason?: string }>;
}

/**
 * Persist the NEW integrated head SHA on the dependent's run after a clean re-gate
 * — the next detect's TERMINATION key. A seam (the production impl writes the run's
 * `integrated_ancestor_shas` jsonb under RLS) so the operation is conformance-
 * tested without a database.
 */
export type RecordIntegratedSha = (input: {
  projectId: string;
  runId: string;
  ancestorSpecId: string;
  sha: string;
}) => Promise<void>;

export interface PercolatingOperationDeps {
  integrator: SpeculativeIntegrator;
  reGate: PercolationReGate;
  recordIntegratedSha: RecordIntegratedSha;
}

export class PercolatingOperation implements PercolationOperation {
  constructor(private readonly deps: PercolatingOperationDeps) {}

  async percolate(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
  }): Promise<PercolationOutcome> {
    const { projectId, dependent, decision } = input;

    // 1. Rebuild the integration branch against the ancestor's NEW state. The
    //    integrator stacks EVERY recorded ancestor (DAG order is the map's key
    //    order; the integrator re-resolves each ancestor's latest branch), so the
    //    rebuilt base reflects the upstream change. An A-vs-other conflict surfaces
    //    here, early — `held` (routed to P2b; retried), the dependent untouched.
    const integration = await this.deps.integrator.buildIntegration({
      projectId,
      dependentSpecId: dependent.specId,
      unmergedAncestorSpecIds: Object.keys(dependent.integratedAncestorShas),
    });
    if (integration.outcome === "conflict") {
      return {
        result: "held",
        ancestorSpecId: decision.ancestorSpecId,
        viaResolver: false,
        reason: integration.message,
      };
    }

    // 2. Re-base + re-gate the dependent against the rebuilt integration (P2a/P2b;
    //    resolver in upstream-change mode on a break). NEVER merge unverified.
    const verdict = await this.deps.reGate.rebaseAndReGate({
      projectId,
      dependent,
      decision,
      integrationBranch: integration.integrationBranch,
    });

    if (verdict.outcome === "absorbed") {
      // Record the new integrated SHA — the termination key for the next detect.
      await this.deps.recordIntegratedSha({
        projectId,
        runId: dependent.runId,
        ancestorSpecId: decision.ancestorSpecId,
        sha: decision.toSha,
      });
      return {
        result: "absorbed",
        ancestorSpecId: decision.ancestorSpecId,
        newIntegratedSha: decision.toSha,
        viaResolver: verdict.viaResolver,
      };
    }

    // replanned: the dependent went back to the planner WITH the change as context.
    return {
      result: "replanned",
      ancestorSpecId: decision.ancestorSpecId,
      viaResolver: verdict.viaResolver,
      ...(verdict.reason !== undefined && { reason: verdict.reason }),
    };
  }
}
