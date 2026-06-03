// The change-percolation COORDINATOR (autonomy-engine.md §2c "Change-percolation —
// NOT discard"). It composes the `ChangePercolation` seams
// (engine/contracts/changePercolation.ts) into the per-project reaction the
// DagWalker subscriber fires alongside the walk, on every run.*-terminal /
// merge.completed / ancestor-PR-update notification. Each pass, per dependent:
//
//   PHASE 1 — SETTLE an in-flight percolation. If the dependent has a `pending`
//   marker, resolve it against the re-execution's lifecycle (pure `decideSettle`):
//     - the re-exec re-gated CLEAN (audited, no open P0/P1) ⇒ absorb (advance the
//       verified SHA — the termination key) + emit `percolated`.
//     - the re-exec halted / could not reconcile ⇒ replan (route back WITH the
//       change as context) + emit `percolation_replan`.
//     - still building ⇒ in-flight; do NOTHING (the loop guard — no re-emit).
//
//   PHASE 2 — DETECT a new change (only when NOT already in flight). Run the pure
//   `decidePercolation` over each ancestor's live SHA vs. the dependent's VERIFIED
//   SHA:
//     - `none`      → unchanged (a no-op / already-absorbed signal never re-fires).
//     - `lazy`      → emit `percolation_deferred` (batched into the next rebase).
//     - `immediate` → emit `percolating`, then KICK OFF a real re-execution
//                     (rebuild → re-base → re-enqueue the dependent so its own
//                     gate+checker+auditor re-run). Held on an ancestor-vs-ancestor
//                     conflict. The change is NOT absorbed here — it absorbs on the
//                     SETTLE of a LATER pass, after the re-execution re-gates clean.
//
// It is a SCHEDULER over the seams (like the DagWalker over the executor). It NEVER
// merges and NEVER records the absorbed key on a bare re-base — absorption requires
// the dependent's OWN governance to re-run clean in a real run.

import {
  decidePercolation,
  decideSettle,
  type PercolationEventEmitter,
  type PercolationKickOff,
  type PercolationPending,
  type PercolationReadModel,
  type PercolationSettler,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";

/** What one full percolation pass over a project produced (for the subscriber + tests). */
export interface PercolationPassResult {
  projectId: string;
  /** Dependents whose re-execution re-gated CLEAN this pass — change ABSORBED. */
  absorbed: string[];
  /** Dependents whose change was non-blocking and DEFERRED to the next rebase (lazy). */
  deferred: string[];
  /** Dependents routed BACK TO THE PLANNER (irreconcilable) — work kept ALIVE, not dropped. */
  replanned: string[];
  /** Dependents whose IMMEDIATE change kicked off a real re-execution this pass. */
  reexecuting: string[];
  /** Dependents whose re-execution is still IN FLIGHT (the loop guard — no re-emit). */
  inFlight: string[];
  /** Dependents HELD this pass (an ancestor-vs-ancestor conflict; retried next notification). */
  held: string[];
  /** Dependents with NO actionable change (the termination key — verified SHA matches). */
  unchanged: string[];
}

export interface ChangePercolationCoordinator {
  /** Run one settle→detect→kick-off pass over a project's speculative dependents. */
  percolate(projectId: string): Promise<PercolationPassResult>;
}

export interface PercolationCoordinatorDeps {
  readModel: PercolationReadModel;
  kickOff: PercolationKickOff;
  settler: PercolationSettler;
  events: PercolationEventEmitter;
}

function emptyResult(projectId: string): PercolationPassResult {
  return {
    projectId,
    absorbed: [],
    deferred: [],
    replanned: [],
    reexecuting: [],
    inFlight: [],
    held: [],
    unchanged: [],
  };
}

/**
 * The production change-percolation coordinator. `percolate(projectId)` runs one
 * settle-then-detect pass over every in-flight speculative dependent (read fresh,
 * RLS-scoped). It NEVER records the absorbed key on a bare re-base — absorption
 * happens only when a real re-execution re-gates clean (PHASE 1 SETTLE), so a
 * percolated change is governance-verified before it can be merged. Dependents are
 * processed in load order; the chain (B absorbs A, then C sees B's advance) converges
 * across passes as each notification re-detects.
 */
export class PercolatingCoordinator implements ChangePercolationCoordinator {
  constructor(private readonly deps: PercolationCoordinatorDeps) {}

  async percolate(projectId: string): Promise<PercolationPassResult> {
    const dependents = await this.deps.readModel.loadSpeculativeDependents(projectId);
    const result = emptyResult(projectId);
    for (const dependent of dependents) {
      await this.processDependent(projectId, dependent, result);
    }
    return result;
  }

  private async processDependent(
    projectId: string,
    dependent: SpeculativeDependent,
    result: PercolationPassResult,
  ): Promise<void> {
    // PHASE 1 — settle any in-flight percolation FIRST. While a marker is set the
    // dependent is mid-absorb; we resolve it (or wait) and NEVER kick a second one
    // off (the loop guard). Only a settled/absent marker proceeds to detection.
    if (dependent.pending !== undefined) {
      await this.settle(projectId, dependent, dependent.pending, result);
      return;
    }
    // PHASE 2 — detect a new change.
    await this.detect(projectId, dependent, result);
  }

  /** PHASE 1: resolve an in-flight percolation against its re-execution lifecycle. */
  private async settle(
    projectId: string,
    dependent: SpeculativeDependent,
    pending: PercolationPending,
    result: PercolationPassResult,
  ): Promise<void> {
    const verdict = decideSettle(dependent.lifecycleState, dependent.openFindingMaxSeverity);
    if (verdict === "in_flight") {
      // The re-execution is still building/pre-audit — wait; do NOT re-emit.
      result.inFlight.push(dependent.specId);
      return;
    }
    if (verdict === "absorbed") {
      // The dependent's OWN gate+checker+auditor re-ran CLEAN against the change.
      // Advance the verified SHA (the termination key) + clear the marker.
      await this.deps.settler.absorb({ projectId, dependent, pending });
      await this.deps.events.emitPercolated({
        projectId,
        specId: dependent.specId,
        runId: dependent.runId,
        ancestorSpecId: pending.ancestorSpecId,
        integratedAncestorSha: pending.toSha,
        viaResolver: false,
      });
      result.absorbed.push(dependent.specId);
      return;
    }
    // verdict === "replanned": the re-execution halted / could not reconcile. Route
    // the dependent back to the planner WITH the change as context (NEVER dropped,
    // NEVER merged) + clear the marker.
    const reason = `re-execution could not reconcile the upstream change from ${pending.ancestorSpecId}`;
    await this.deps.settler.replan({ projectId, dependent, pending, reason });
    await this.deps.events.emitPercolationReplan({
      projectId,
      specId: dependent.specId,
      runId: dependent.runId,
      ancestorSpecId: pending.ancestorSpecId,
      ancestorSha: pending.toSha,
      reason,
    });
    result.replanned.push(dependent.specId);
  }

  /** PHASE 2: detect a new actionable change + kick off / defer. */
  private async detect(
    projectId: string,
    dependent: SpeculativeDependent,
    result: PercolationPassResult,
  ): Promise<void> {
    const signals = await this.deps.readModel.loadAncestorSignals({ projectId, dependent });
    const decisions = signals
      .map((s) => decidePercolation(s))
      .sort((a, b) => a.ancestorSpecId.localeCompare(b.ancestorSpecId));

    // The MERGED ancestors (the new §2c divergence axis): the kick-off DROPS these
    // from the speculative stack (their content arrives via fresh main) — when EVERY
    // ancestor merged the re-base is onto plain default_branch (non-speculative).
    const mergedAncestorSpecIds = signals.filter((s) => s.ancestorMerged === true).map((s) => s.ancestorSpecId);

    const immediate = decisions.find((d) => d.promptness === "immediate");
    if (immediate !== undefined) {
      const severity = immediate.immediateSeverity;
      if (severity === undefined) {
        throw new Error(
          `immediate percolation for ${dependent.specId} (ancestor ${immediate.ancestorSpecId}) lacked a severity`,
        );
      }
      await this.deps.events.emitPercolating({
        projectId,
        specId: dependent.specId,
        runId: dependent.runId,
        ancestorSpecId: immediate.ancestorSpecId,
        fromAncestorSha: immediate.fromSha,
        toAncestorSha: immediate.toSha,
        severity,
      });
      const outcome = await this.deps.kickOff.kickOff({
        projectId,
        dependent,
        decision: immediate,
        mergedAncestorSpecIds,
      });
      if (outcome.result === "reexecuting") {
        // A REAL re-execution is now in flight; it settles (absorbs/replans) on a
        // later pass once its gate+checker+auditor terminate. Not absorbed here.
        result.reexecuting.push(dependent.specId);
      } else {
        // held: an ancestor-vs-ancestor conflict on the rebuild (routed to P2b);
        // the dependent is untouched + retried next notification.
        result.held.push(dependent.specId);
      }
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

    // No actionable change — every ancestor's live SHA still matches what the
    // dependent re-gated clean against (the termination key).
    result.unchanged.push(dependent.specId);
  }
}
