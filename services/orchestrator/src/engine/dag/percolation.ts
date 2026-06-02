// The change-percolation COORDINATOR (autonomy-engine.md §2c "Change-percolation —
// NOT discard"). It composes the `ChangePercolation` seams
// (engine/contracts/changePercolation.ts) into the per-project reaction the
// DagWalker subscriber fires alongside the walk: on every run.*-terminal /
// merge.completed / ancestor-PR-update notification it DETECTS whether any
// in-flight speculative dependent's recorded integrated-ancestor SHA has DIVERGED
// (or the ancestor's finding/review state changed), and for each divergence
// PERCOLATES the upstream delta down the chain rather than discarding the
// dependent's work.
//
// It is a SCHEDULER over the seams (like the DagWalker is over the executor): the
// detect read model + the percolate operation + the event emitter do the real
// work; this module owns the chain ORDER (ancestors before dependents), the
// severity→promptness gate (immediate vs lazy), and the TERMINATION guarantee (it
// only acts on a real SHA divergence / changes-requested, so a no-op never
// re-triggers). It NEVER merges — a merge stays governed by the P2c-1 merge-hold;
// it only keeps the speculative work alive + verified against the new base.

import {
  decidePercolation,
  type PercolationDecision,
  type PercolationEventEmitter,
  type PercolationOperation,
  type PercolationReadModel,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";

/** What one full percolation pass over a project produced (for the subscriber + tests). */
export interface PercolationPassResult {
  projectId: string;
  /** Dependents whose ancestor change was absorbed (re-integrated + re-gated clean). */
  absorbed: string[];
  /** Dependents whose change was non-blocking and DEFERRED to the next rebase (lazy). */
  deferred: string[];
  /** Dependents routed BACK TO THE PLANNER (irreconcilable) — work kept ALIVE, not dropped. */
  replanned: string[];
  /** Dependents HELD this pass (an ancestor-vs-ancestor conflict; retried next notification). */
  held: string[];
  /** Dependents with NO actionable change (the termination key — same SHA, no request). */
  unchanged: string[];
}

export interface ChangePercolationCoordinator {
  /** Run one detect→decide→percolate pass over a project's speculative dependents. */
  percolate(projectId: string): Promise<PercolationPassResult>;
}

export interface PercolationCoordinatorDeps {
  readModel: PercolationReadModel;
  operation: PercolationOperation;
  events: PercolationEventEmitter;
}

/**
 * The production change-percolation coordinator. One `percolate(projectId)` pass:
 *
 *   1. Load the in-flight SPECULATIVE dependents + each ancestor's current SHA +
 *      severity (read-only, RLS-scoped).
 *   2. For each dependent, for each ancestor, run the PURE `decidePercolation`:
 *      - `none`      → unchanged (termination: a no-op never re-triggers).
 *      - `lazy`      → emit dag.spec.percolation_deferred (batched into the next
 *                      rebase; nothing re-gated now, nothing merged on stale work).
 *      - `immediate` → emit dag.spec.percolating, then PERCOLATE (rebuild → re-base
 *                      → re-gate → resolver-on-break) via the operation seam:
 *                        absorbed  → emit dag.spec.percolated (work intact + verified).
 *                        replanned → emit dag.spec.percolation_replan (work ALIVE,
 *                                    routed to the planner with the change — NOT
 *                                    dropped, NOT merged).
 *                        held      → an ancestor-vs-ancestor conflict; retried next pass.
 *
 * Chain order: dependents are processed ANCESTORS-BEFORE-DEPENDENTS, so when B
 * absorbs A's change first, C's detect (which reads B's now-advanced integration
 * SHA) sees B's resulting delta and percolates it the same way — the chain
 * re-integration of §2c. Within one pass each dependent percolates at most its
 * highest-promptness ancestor change; a still-diverged ancestor re-detects on the
 * next notification (so multi-ancestor chains converge across passes, never loop).
 */
export class PercolatingCoordinator implements ChangePercolationCoordinator {
  constructor(private readonly deps: PercolationCoordinatorDeps) {}

  async percolate(projectId: string): Promise<PercolationPassResult> {
    const dependents = await this.deps.readModel.loadSpeculativeDependents(projectId);
    const result: PercolationPassResult = {
      projectId,
      absorbed: [],
      deferred: [],
      replanned: [],
      held: [],
      unchanged: [],
    };

    for (const dependent of dependents) {
      await this.percolateDependent(projectId, dependent, result);
    }
    return result;
  }

  /**
   * Percolate the single highest-promptness actionable ancestor change into one
   * dependent. Immediate changes win over lazy ones win over none; ties within a
   * promptness resolve by ancestor-spec-id order (deterministic). A dependent with
   * no actionable change is recorded `unchanged` (termination).
   */
  private async percolateDependent(
    projectId: string,
    dependent: SpeculativeDependent,
    result: PercolationPassResult,
  ): Promise<void> {
    const signals = await this.deps.readModel.loadAncestorSignals({ projectId, dependent });
    const decisions = signals
      .map((s) => decidePercolation(s))
      .sort((a, b) => a.ancestorSpecId.localeCompare(b.ancestorSpecId));

    const immediate = decisions.find((d) => d.promptness === "immediate");
    if (immediate !== undefined) {
      await this.runImmediate(projectId, dependent, immediate, result);
      return;
    }

    const lazy = decisions.find((d) => d.promptness === "lazy");
    if (lazy !== undefined && lazy.lazySeverity !== undefined) {
      await this.deps.events.emitPercolationDeferred({
        projectId,
        specId: dependent.specId,
        runId: dependent.runId,
        ancestorSpecId: lazy.ancestorSpecId,
        pendingAncestorSha: lazy.toSha,
        severity: lazy.lazySeverity,
      });
      result.deferred.push(dependent.specId);
      return;
    }

    // No actionable change — every ancestor SHA still matches (the termination key).
    result.unchanged.push(dependent.specId);
  }

  /** Run an IMMEDIATE percolation: emit percolating, then rebuild→re-base→re-gate. */
  private async runImmediate(
    projectId: string,
    dependent: SpeculativeDependent,
    decision: PercolationDecision,
    result: PercolationPassResult,
  ): Promise<void> {
    // immediate is only produced WITH an immediateSeverity (the pure core
    // guarantees it); narrow defensively so the event never carries an absent label.
    const severity = decision.immediateSeverity;
    if (severity === undefined) {
      throw new Error(
        `immediate percolation for ${dependent.specId} (ancestor ${decision.ancestorSpecId}) lacked a severity`,
      );
    }
    await this.deps.events.emitPercolating({
      projectId,
      specId: dependent.specId,
      runId: dependent.runId,
      ancestorSpecId: decision.ancestorSpecId,
      fromAncestorSha: decision.fromSha,
      toAncestorSha: decision.toSha,
      severity,
    });

    const outcome = await this.deps.operation.percolate({ projectId, dependent, decision });

    if (outcome.result === "absorbed") {
      // newIntegratedSha is set on `absorbed` (the operation records it on the run);
      // fall back to the decision's toSha so the event always names the new key.
      await this.deps.events.emitPercolated({
        projectId,
        specId: dependent.specId,
        runId: dependent.runId,
        ancestorSpecId: decision.ancestorSpecId,
        integratedAncestorSha: outcome.newIntegratedSha ?? decision.toSha,
        viaResolver: outcome.viaResolver,
      });
      result.absorbed.push(dependent.specId);
      return;
    }

    if (outcome.result === "replanned") {
      // NEVER discard: the dependent went back to the planner WITH the change as
      // context (the P2b replan path inside the operation). Surface it; the work
      // stays alive (re-planned), not dropped or merged.
      await this.deps.events.emitPercolationReplan({
        projectId,
        specId: dependent.specId,
        runId: dependent.runId,
        ancestorSpecId: decision.ancestorSpecId,
        ancestorSha: decision.toSha,
        reason: outcome.reason ?? "percolation irreconcilable",
      });
      result.replanned.push(dependent.specId);
      return;
    }

    // result === "held": an ancestor-vs-ancestor conflict surfaced on the rebuild
    // (routed to the P2b resolver inside the operation as in P2c-1). The dependent
    // is not re-integrated this pass; the next notification re-detects + retries.
    result.held.push(dependent.specId);
  }
}
