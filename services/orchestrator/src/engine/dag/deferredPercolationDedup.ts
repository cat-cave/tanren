// Per-spec state-transition gate for the `dag.spec.percolation_deferred` emit.
//
// THE BUG (apex v35, live). A lazy/deferred dependent re-emitted
// `dag.spec.percolation_deferred` (carrying a `runId`) on EVERY percolation pass with no
// idempotency gate. The append fires a `tanren_run` NOTIFY (any append with a `runId`),
// which re-wakes `DagWalkerSubscriber` → re-walk → re-percolate → re-emit: a self-feeding
// hot-loop (the live run emitted 1030 `percolation_deferred` events in seconds). Worse, the
// `HeldReDriveBackoff` that SPACES the `held` path is explicitly CLEARED on the deferred path,
// so there was zero spacing.
//
// THE FIX. A deferred percolation is a STATE, not an event-per-pass: emit
// `percolation_deferred` only on a STATE TRANSITION — when the (ancestor, pending SHA) a
// dependent is deferring on CHANGES from the last one we emitted for that spec. An unchanged
// pending SHA is the same lazy state already on the timeline; re-emitting it adds no
// information and only re-feeds the bus. A genuine new lazy change (a different ancestor or a
// new pending SHA) IS a transition and DOES re-emit, so the fix never suppresses a real
// re-evaluation. The state is per-spec and CLEARED the moment the spec stops being lazily
// deferred (it absorbs / re-execs / replans / is held / unchanged), so a later return to the
// deferred state re-emits once.
//
// In-process (the coordinator is a long-lived singleton driven by the subscriber); a restart
// simply starts fresh — the worst case is ONE extra deferred emit after a restart, never a
// hot-loop. No cap, no deadline: a changed state always re-emits.

/** The deferred signal a spec is currently parked on (the transition key). */
interface DeferredSignal {
  ancestorSpecId: string;
  pendingAncestorSha: string;
}

/**
 * Tracks, per spec, the last `percolation_deferred` (ancestor, pending SHA) emitted, so a
 * repeated pass over an UNCHANGED deferred state does not re-emit (and re-feed the bus). A
 * CHANGED signal is a genuine transition and re-emits.
 */
export class DeferredPercolationDedup {
  private readonly lastEmitted = new Map<string, DeferredSignal>();

  /**
   * True iff `percolation_deferred` should be emitted for `specId` deferring on
   * `signal` — i.e. this is the FIRST deferred for the spec, or its (ancestor, pending SHA)
   * differs from the last one emitted (a genuine state transition). Records the new signal
   * as the latest when it returns true (so the next unchanged pass is suppressed).
   */
  shouldEmit(specId: string, signal: DeferredSignal): boolean {
    const prior = this.lastEmitted.get(specId);
    if (
      prior !== undefined &&
      prior.ancestorSpecId === signal.ancestorSpecId &&
      prior.pendingAncestorSha === signal.pendingAncestorSha
    ) {
      return false;
    }
    this.lastEmitted.set(specId, { ...signal });
    return true;
  }

  /**
   * Clear `specId`'s deferred state — call when the spec STOPS being lazily deferred (it
   * absorbed, re-executed, replanned, was held, or is unchanged). A later return to the
   * deferred state then re-emits once (a genuine new transition), never suppressed by a
   * stale marker.
   */
  clear(specId: string): void {
    this.lastEmitted.delete(specId);
  }
}
