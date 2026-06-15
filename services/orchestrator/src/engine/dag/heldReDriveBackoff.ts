// Per-spec backoff for the base-shift / percolation HELD re-drive.
//
// THE BUG (apex v35, live, Part B — the DEFENSE). A base-shift HELD (`change-percolation`:
// "dependent HELD; work survives, retried next notification") retries on the NEXT
// percolation notification — and those fire RAPIDLY (the live run emitted 388
// `dag.spec.percolating` events). With NO spacing a TRANSIENT infra hold (e.g. the
// host-key-discovery `ECONNRESET` Part A now retries) re-failed ~4 times in ~3 seconds,
// burning straight through the consecutive-same-failure cap (K=4, the unified finalize
// model) → a FALSE `persistent_failure` escalation to `needs_attention`.
//
// THE FIX. Gate the SAME spec's HELD re-drive on a minimum interval: once a spec is HELD,
// it is not eligible to re-drive again until its `retryAfter` timestamp passes. The
// interval grows on consecutive holds (the shared recoverable backoff curve: 3s → 10s →
// 30s → 60s, clamped) so a genuinely persistent hold still re-drives — just SPACED — and
// the K-cap counts genuine repeated failures over TIME, not a sub-second hot-loop. The
// state is per-spec and cleared the moment the spec stops being held (it absorbs / re-execs
// / replans / is unchanged), so a recovered spec starts fresh. Bounded: it always re-drives
// (clamped to the longest delay), never a wall-clock give-up, never an infinite hot-loop.

import { recoverableRetryDelayMs } from "../merge/retrySchedule.js";

interface HeldEntry {
  /** Consecutive HELD count for this spec (1-based; resets when the spec stops being held). */
  holds: number;
  /** Wall-clock ms before which a re-drive of this spec must be SKIPPED (spaced). */
  nextEligibleAtMs: number;
}

/**
 * Tracks the per-spec HELD backoff window. Clock-injected so it is deterministic in tests.
 * In-process (the coordinator is a long-lived singleton driven by the subscriber); a
 * restart simply starts the backoff fresh, which is safe — the worst case is one extra
 * spaced re-drive, never a hot-loop.
 */
export class HeldReDriveBackoff {
  private readonly entries = new Map<string, HeldEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * True iff a re-drive of `specId` should be SKIPPED right now because its last HELD was
   * within the backoff window. A spec with no recorded hold (or whose window has elapsed)
   * is eligible (returns false).
   */
  shouldSkip(specId: string): boolean {
    const entry = this.entries.get(specId);
    return entry !== undefined && this.now() < entry.nextEligibleAtMs;
  }

  /** The ms remaining before `specId` is re-drive-eligible (0 when eligible / untracked). */
  remainingMs(specId: string): number {
    const entry = this.entries.get(specId);
    if (entry === undefined) {
      return 0;
    }
    return Math.max(0, entry.nextEligibleAtMs - this.now());
  }

  /**
   * Record that `specId` was HELD this pass: bump its consecutive-hold count and set the
   * next-eligible timestamp the recoverable backoff curve dictates (3s → 10s → 30s → 60s,
   * clamped). Returns the chosen delay (for logging/observability).
   */
  recordHeld(specId: string): { holds: number; delayMs: number } {
    const prior = this.entries.get(specId);
    const holds = (prior?.holds ?? 0) + 1;
    const delayMs = recoverableRetryDelayMs(holds);
    this.entries.set(specId, { holds, nextEligibleAtMs: this.now() + delayMs });
    return { holds, delayMs };
  }

  /**
   * Clear `specId`'s held state — call when the spec STOPS being held (it absorbed,
   * re-executed, replanned, was unchanged/skipped). A recovered spec must start fresh so a
   * later genuine hold gets the full curve, not a stale long delay.
   */
  clear(specId: string): void {
    this.entries.delete(specId);
  }
}
