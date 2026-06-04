// The NEVER-STRAND reconciler COORDINATOR. It composes the `SpecStrandReconciler`
// seams (engine/contracts/specStrandReconciler.ts) into the per-project safety-net
// pass the DagWalker subscriber fires LAST in its chain (walk → percolate →
// reconcile) plus a low-frequency periodic backstop. Each pass, per slot-occupying
// spec:
//
//   1. Decide the pure strand predicate (`decideStrand`) over the spec's live facts
//      (runs + merge-queue + percolation markers). A spec that is legitimately
//      running / queued / merge-queued / mid-LIVE-percolation is NOT a strand.
//   2. A confirmed strand under the bounded re-enqueue cap → flip `active → pending`
//      (re-enqueue, `notFromStatuses`-guarded), CLEAR the orphaned percolation
//      marker (so it isn't re-detected), and emit a LOUD `dag.spec.unstranded`. This
//      is the AUTONOMOUS SELF-HEAL tier (the escalation discipline): a stranding is a
//      MECHANICAL fault, so the system's own first response is to re-run/re-plan the
//      spec — no human is involved while the bounded budget lasts.
//   3. A confirmed strand that has ALREADY been re-enqueued more than the cap →
//      escalate to `needs_attention` (terminal — frees the slot, blocks only
//      dependents) + emit `dag.spec.needs_attention` with a DECISION-framed message
//      (source `strand`): the autonomous self-heal exhausted its budget, so a human
//      must DECIDE how to unblock the spec — framed as "can't make progress, decide",
//      NOT "an error occurred" (the human-escalation-discipline). It does NOT
//      re-enqueue, so the DAG can never infinite-loop on a strand (the bounded
//      backstop prevents runaway).
//
// Idempotent + composition-safe: it runs LAST so percolation owns any live-marker
// spec (condition 4 hand-off); the flip is `notFromStatuses`-guarded; and the
// condition RE-CHECKS live runs each pass — a spec already re-enqueued now has a
// queued run, so it fails condition 2 next pass and is skipped (no double-run). Two
// workers racing both set the spec to the SAME `pending` (idempotent), and only one
// walker tick wins the `pending → active` claim (the existing SpecNotRunnableError
// boundary). It is a SCHEDULER over the seams — it NEVER runs work itself.

import type {
  SpecStrandEventEmitter,
  SpecStrandReadModel,
  SpecStrandReconcilePassResult,
  SpecStrandReconcilerContract,
  SpecStrandSnapshot,
  SpecStrandWriter,
} from "../contracts/specStrandReconciler.js";
import { decideStrand } from "../contracts/specStrandReconciler.js";

/**
 * The bounded re-enqueue cap: a strand may be re-enqueued AT MOST this many times.
 * Once the count of prior `dag.spec.unstranded` events REACHES this (`>=`), the next
 * reconcile escalates to `needs_attention` instead of re-enqueuing — so the spec is
 * re-enqueued at most 3 times, then surfaces a bounded, loud ask-for-help (never an
 * infinite loop). (Using `>=` here: after 3 successful unstrands the 4th detection
 * escalates rather than re-enqueuing a 4th time.)
 */
export const MAX_UNSTRAND_ATTEMPTS = 3;

/**
 * The decision-framed escalation message (the human-escalation-discipline). The
 * re-enqueue retries are the AUTONOMOUS self-heal tier — re-running/re-planning the
 * spec is the system's own first response to a mechanical stranding. Only when that
 * self-heal has run out (the bounded cap) does a human enter, and then the ask is a
 * GENUINE "can't make progress, decide" — never "an error occurred". This message
 * frames exactly that: the autonomous self-heal exhausted its budget, so a person
 * must decide how to unblock the spec (not debug an error). It mirrors the
 * merge_conflict source's product-decision framing so both parked states read alike.
 */
function strandEscalationMessage(specId: string, attempts: number): string {
  return (
    `the autonomous self-heal could not make progress on spec ${specId}: it was re-enqueued ` +
    `${attempts} times (re-run/re-planned) and STILL stranded with no live run each time — a ` +
    `decision is needed on how to unblock it (re-scope the spec, fix its dependencies, or route ` +
    `past it), not an error to debug.`
  );
}

export interface SpecStrandReconcilerDeps {
  readModel: SpecStrandReadModel;
  writer: SpecStrandWriter;
  events: SpecStrandEventEmitter;
}

/**
 * The production strand reconciler. `reconcile(projectId)` runs one detect →
 * heal/escalate pass over every slot-occupying spec (read fresh, RLS-scoped). It
 * NEVER re-enqueues a spec that is legitimately running/queued/merge-queued/
 * mid-LIVE-percolation (the pure `decideStrand` guards that), and NEVER re-enqueues
 * a strand more than the bounded cap (it escalates to `needs_attention` instead).
 */
export class SpecStrandReconciler implements SpecStrandReconcilerContract {
  constructor(private readonly deps: SpecStrandReconcilerDeps) {}

  async reconcile(projectId: string): Promise<SpecStrandReconcilePassResult> {
    const candidates = await this.deps.readModel.loadStrandCandidates(projectId);
    const result: SpecStrandReconcilePassResult = { projectId, reEnqueued: [], escalated: [] };
    for (const candidate of candidates) {
      await this.processCandidate(projectId, candidate, result);
    }
    return result;
  }

  private async processCandidate(
    projectId: string,
    candidate: SpecStrandSnapshot,
    result: SpecStrandReconcilePassResult,
  ): Promise<void> {
    const decision = decideStrand(candidate);
    if (!decision.reconcilable) return;

    const priorUnstrands = await this.deps.readModel.countPriorUnstrands({ projectId, specId: candidate.specId });

    // BOUNDED ESCALATION: once the spec has ALREADY been re-enqueued the cap number of
    // times (`>=`), do NOT re-enqueue again — escalate to the terminal `needs_attention`
    // status (frees the slot, blocks only dependents) and surface the halt history.
    if (priorUnstrands >= MAX_UNSTRAND_ATTEMPTS) {
      // ATOMIC: only escalate a spec that is STILL `active` + the strand invariant
      // STILL holds (the same guard the re-enqueue uses). If a concurrent re-exec
      // reclaimed it between the read and here, the flip matches zero rows → no-op.
      const { flipped } = await this.deps.writer.escalateSpec({ projectId, specId: candidate.specId });
      if (!flipped) return;
      // Clear any orphaned marker so a re-detect can't keep the spec churning.
      for (const runId of decision.orphanedMarkerRunIds) {
        await this.deps.writer.clearOrphanedMarker({ projectId, runId });
      }
      await this.deps.events.emitNeedsAttention({
        projectId,
        specId: candidate.specId,
        reason: decision.reason,
        terminalRuns: decision.terminalRuns,
        attempts: priorUnstrands,
        message: strandEscalationMessage(candidate.specId, priorUnstrands),
      });
      result.escalated.push(candidate.specId);
      return;
    }

    // CONFIRMED STRAND under the cap → re-enqueue. The ATOMIC guarded flip re-checks
    // the strand invariant in the same UPDATE, so a concurrent re-exec that created a
    // live run / reclaimed the spec between the read and the flip yields ZERO rows
    // (`flipped:false`) → a safe no-op: skip clearing the marker + emitting the event
    // (no double-run, no spurious `dag.spec.unstranded`). The next pass re-detects.
    const { flipped } = await this.deps.writer.reEnqueueSpec({ projectId, specId: candidate.specId });
    if (!flipped) return;
    for (const runId of decision.orphanedMarkerRunIds) {
      await this.deps.writer.clearOrphanedMarker({ projectId, runId });
    }
    await this.deps.events.emitUnstranded({
      projectId,
      specId: candidate.specId,
      reason: decision.reason,
      terminalRuns: decision.terminalRuns,
      // The 1-based attempt number this re-enqueue represents (prior count + 1).
      attempt: priorUnstrands + 1,
    });
    result.reEnqueued.push(candidate.specId);
  }
}
