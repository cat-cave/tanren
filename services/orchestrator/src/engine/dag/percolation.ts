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
import { SpecNotRunnableError } from "../workflow/projectSpecErrors.js";
import { BaseShiftHeldError } from "./baseShiftCoordinator.js";
import { HeldReDriveBackoff } from "./heldReDriveBackoff.js";
import { DeferredPercolationDedup } from "./deferredPercolationDedup.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("change-percolation");

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
  /**
   * Dependents HELD this pass — a RECOVERABLE hold (NOT a failure), retried on the next
   * notification: an ancestor-vs-ancestor rebuild conflict, OR a fail-closed
   * `BaseShiftHeldError` (the never-discard base-shift rebase/resolver/gate could not
   * settle — the work survives untouched; Wave 3 resumes it once the live runner is
   * plumbed). Distinct from `failed` (a real, non-recoverable error).
   */
  held: string[];
  /** Dependents with NO actionable change (the termination key — verified SHA matches). */
  unchanged: string[];
  /**
   * Dependents BENIGNLY SKIPPED this pass: the spec became merged/done between the
   * load and the re-execution kick-off, so its claim raised SpecNotRunnableError (a
   * terminal spec is not re-runnable). The change is moot (a merged spec carries its
   * upstream content already); skip it WITHOUT aborting the pass — the OTHER
   * dependents are still processed, and the stale marker is cleared next pass.
   */
  skipped: string[];
  /**
   * Dependents whose processing THREW a non-benign error this pass (a transient DB/RLS/
   * VcsProvider failure in settle OR detect). RECORD-AND-CONTINUE (the walker's tolerate
   * pattern): the error is logged + the dependent recorded here, but the pass CONTINUES
   * so one dependent's failure can NEVER starve the OTHERS. A re-execution kicked off
   * before a later throw is NOT rolled back — it settles on a later pass; the throwing
   * dependent re-detects on the next notification (the loop re-converges). This is NOT a
   * silent swallow — the loud per-dependent log + this bucket surface it; only the
   * pass-aborting blast radius is removed. (The benign terminal case stays in `skipped`.)
   */
  failed: string[];
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
  /**
   * Per-spec HELD re-drive backoff (Part B of the apex-v35 false-escalation fix). The
   * percolation notification fires RAPIDLY (the live run: 388 `percolating` events), so a
   * TRANSIENT base-shift HOLD would otherwise re-fail many times per second and burn the
   * consecutive-same-failure cap (K=4) into a FALSE `persistent_failure`. This spaces the
   * re-drive of the SAME held spec (3s → 10s → 30s → 60s, clamped) so the K-cap counts
   * genuine repeated failures over TIME, not a sub-second hot-loop. Injectable for tests
   * (clock control); a default in-memory instance is used when absent.
   */
  heldBackoff?: HeldReDriveBackoff;
  /**
   * Per-spec STATE-TRANSITION gate for the `percolation_deferred` emit (the apex-v35
   * deploy/percolation hot-loop fix). A lazy/deferred dependent re-emitted
   * `percolation_deferred` (with a `runId`) on EVERY pass — the append fires a `tanren_run`
   * NOTIFY → re-wakes the walker → re-percolates → re-emits, a self-feeding hot-loop (1030
   * events in seconds in the live run). This gate emits ONLY on a state transition (the
   * deferred (ancestor, pending SHA) changed from the last one emitted for the spec); an
   * unchanged deferred state is already on the timeline, so it is suppressed. A genuine new
   * lazy change still re-emits. Injectable for tests; a default in-memory instance is used
   * when absent.
   */
  deferredDedup?: DeferredPercolationDedup;
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
    skipped: [],
    failed: [],
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
  private readonly heldBackoff: HeldReDriveBackoff;
  private readonly deferredDedup: DeferredPercolationDedup;

  constructor(private readonly deps: PercolationCoordinatorDeps) {
    this.heldBackoff = deps.heldBackoff ?? new HeldReDriveBackoff();
    this.deferredDedup = deps.deferredDedup ?? new DeferredPercolationDedup();
  }

  async percolate(projectId: string): Promise<PercolationPassResult> {
    const dependents = await this.deps.readModel.loadSpeculativeDependents(projectId);
    const result = emptyResult(projectId);
    for (const dependent of dependents) {
      // RECORD-AND-CONTINUE (the walker's tolerate pattern): a transient DB/RLS/
      // VcsProvider throw while processing ONE dependent (settle OR detect) must not
      // ABORT the whole pass and starve the remaining dependents. Log it loudly +
      // record it in `failed`, then carry on; the dependent re-detects next notification.
      // (The benign terminal SpecNotRunnableError is still handled inside `detect` →
      // `skipped`; it never reaches here.)
      try {
        await this.processDependent(projectId, dependent, result);
      } catch (error) {
        // A fail-closed HOLD (the never-discard base-shift rebase/resolver/gate could not
        // settle) is NOT a failure — the work survives untouched and is retried on the
        // next notification (Wave 3 resumes it once the live runner is plumbed). Classify
        // it as `held` (a distinct recoverable outcome), so "the live engine HOLDS the
        // work" is observable + visibly recoverable, never mislabeled a real failure.
        if (error instanceof BaseShiftHeldError) {
          // Part B (apex-v35): record the HELD so the SAME spec's next re-drive is SPACED
          // by the backoff curve — a transient hold must not re-fail 4× in 3s and burn the
          // K-cap into a false `persistent_failure`. The work survives untouched.
          const { holds, delayMs } = this.heldBackoff.recordHeld(dependent.specId);
          log.warn("dependent HELD (fail-closed; work survives, re-drive spaced by backoff)", {
            specId: dependent.specId,
            message: error.message,
            consecutiveHolds: holds,
            nextReDriveInMs: delayMs,
          });
          // Held (not lazily deferred) — drop any deferred-emit marker so a later return to
          // the deferred state re-emits once.
          this.deferredDedup.clear(dependent.specId);
          result.held.push(dependent.specId);
          continue;
        }
        log.error(
          "dependent threw while percolating (recorded + continuing; other dependents still process)",
          {
            specId: dependent.specId,
          },
          error,
        );
        result.failed.push(dependent.specId);
      }
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
    // off (the loop guard). Only a settled/absent marker proceeds to detection. A
    // settle means the dependent is NOT held this pass — clear any HELD backoff so a
    // later genuine hold starts the curve fresh.
    if (dependent.pending !== undefined) {
      this.heldBackoff.clear(dependent.specId);
      // A spec in SETTLE (mid-absorb) is no longer in the lazy-deferred state — drop any
      // deferred-emit marker so a later return to deferred re-emits once.
      this.deferredDedup.clear(dependent.specId);
      await this.settle(projectId, dependent, dependent.pending, result);
      return;
    }
    // Part B (apex-v35): a spec HELD on a recent pass is not re-drive-eligible until its
    // backoff window elapses — SKIP the kick-off (which would re-fail a transient infra
    // hold) and keep it `held` this pass. The percolation notification fires rapidly (388
    // `percolating` events in the live run); without this a transient hold re-fails ~4× in
    // ~3s and burns the K=4 consecutive-failure cap into a FALSE escalation. The work is
    // untouched; it re-drives once spaced, so a GENUINE persistent hold still escalates at
    // K — just counting spaced retries over time, never a sub-second hot-loop.
    if (this.heldBackoff.shouldSkip(dependent.specId)) {
      log.debug("dependent HELD re-drive spaced by backoff (skipped this notification)", {
        specId: dependent.specId,
        remainingMs: this.heldBackoff.remainingMs(dependent.specId),
      });
      result.held.push(dependent.specId);
      // Held (not lazily deferred) this pass — drop any deferred-emit marker so a later
      // RETURN to the deferred state re-emits once (a genuine new transition).
      this.deferredDedup.clear(dependent.specId);
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
    // §5 P0: the dependent's OWN review verdict is now a settle input — a
    // `changes_requested` re-exec NEVER absorbs (it does not advance the verified
    // SHA), closing the absorb-without-reading-the-verdict hole.
    const verdict = decideSettle(dependent.lifecycleState, dependent.openFindingMaxSeverity, dependent.reviewVerdict);
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
      let outcome;
      try {
        outcome = await this.deps.kickOff.kickOff({
          projectId,
          dependent,
          decision: immediate,
          mergedAncestorSpecIds,
        });
      } catch (error) {
        // TOLERATE a candidate that became terminal between load and kick-off: the
        // re-execution reopens the spec to `pending` (a no-op once merged/done) then
        // claims it, and the claim raises SpecNotRunnableError on a non-`pending`
        // spec. A merged spec is never a percolation dependent (its re-base is moot),
        // so SKIP it benignly — debug-log, record it, and let the pass CONTINUE
        // processing the OTHER dependents. Every OTHER error still propagates (no
        // silent fallback). Mirrors the walker's enqueueOrTolerate spirit (#278).
        if (error instanceof SpecNotRunnableError) {
          log.debug(
            "skipped dependent: became terminal between load and re-exec (not a percolation dependent) — benign",
            {
              specId: dependent.specId,
              status: error.status,
            },
          );
          // Terminal/moot — not held; clear any backoff + deferred-emit marker.
          this.heldBackoff.clear(dependent.specId);
          this.deferredDedup.clear(dependent.specId);
          result.skipped.push(dependent.specId);
          return;
        }
        throw error;
      }
      if (outcome.result === "reexecuting") {
        // A REAL re-execution is now in flight; it settles (absorbs/replans) on a
        // later pass once its gate+checker+auditor terminate. Not absorbed here. NOT held
        // this pass — clear any backoff so a later genuine hold starts the curve fresh.
        // Not lazily deferred — drop any deferred-emit marker too.
        this.heldBackoff.clear(dependent.specId);
        this.deferredDedup.clear(dependent.specId);
        result.reexecuting.push(dependent.specId);
      } else {
        // held: a never-discard base-shift hold surfaced as a structured kick-off result
        // (a spec-vs-spec assembly conflict now surfaces as a `BaseShiftHeldError` thrown
        // from the rebase, caught at the pass level above). The dependent is untouched +
        // retried next notification — Part B SPACES that re-drive so a transient hold can
        // never burn the K-cap into a false escalation.
        const { holds, delayMs } = this.heldBackoff.recordHeld(dependent.specId);
        log.warn("dependent HELD via kick-off result; re-drive spaced by backoff", {
          specId: dependent.specId,
          consecutiveHolds: holds,
          nextReDriveInMs: delayMs,
        });
        // Held (not lazily deferred) — drop any deferred-emit marker so a later return to
        // the deferred state re-emits once.
        this.deferredDedup.clear(dependent.specId);
        result.held.push(dependent.specId);
      }
      return;
    }

    const lazy = decisions.find((d) => d.promptness === "lazy");
    if (lazy !== undefined && lazy.lazySeverity !== undefined) {
      // STATE-TRANSITION gate (the apex-v35 hot-loop fix): emit `percolation_deferred` ONLY
      // when the deferred (ancestor, pending SHA) CHANGED from the last one emitted for this
      // spec. The emit carries a `runId`, so an append fires a `tanren_run` NOTIFY that
      // re-wakes the walker → re-percolates → would re-emit the SAME deferred state forever
      // (the 1030-events-in-seconds live hot-loop). An unchanged deferred state is already on
      // the timeline; suppress the re-emit. A GENUINE new lazy change (different ancestor /
      // new pending SHA) is a transition and DOES re-emit — the dependent stays in `deferred`
      // either way (the lazy state is unchanged), the only difference is the redundant emit.
      if (
        this.deferredDedup.shouldEmit(dependent.specId, {
          ancestorSpecId: lazy.ancestorSpecId,
          pendingAncestorSha: lazy.toSha,
        })
      ) {
        await this.deps.events.emitPercolationDeferred({
          projectId,
          specId: dependent.specId,
          runId: dependent.runId,
          ancestorSpecId: lazy.ancestorSpecId,
          pendingAncestorSha: lazy.toSha,
          severity: lazy.lazySeverity,
        });
      }
      // Deferred (lazy) — not held this pass; clear any backoff.
      this.heldBackoff.clear(dependent.specId);
      result.deferred.push(dependent.specId);
      return;
    }

    // No actionable change — every ancestor's live SHA still matches what the
    // dependent re-gated clean against (the termination key). Not held / not deferred;
    // clear both the backoff and the deferred-emit marker.
    this.heldBackoff.clear(dependent.specId);
    this.deferredDedup.clear(dependent.specId);
    result.unchanged.push(dependent.specId);
  }
}
