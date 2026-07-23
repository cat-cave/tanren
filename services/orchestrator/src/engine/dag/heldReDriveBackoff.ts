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
//
// APEX v45 EXTENSION — ancestor-progress gating (the run-cycle hot-loop fix):
// The time-based window above defends against NOTIFICATION STORMS (rapid re-walks while the
// ancestor has not changed). It does NOT defend against the RUN-CYCLE HOT-LOOP: a speculative
// dependent's run takes 30-65s (runner alloc + jj clone) and terminates with
// `AncestorNotReadyError`. By the time the run terminates and the walker re-walks, the 3s
// (or even 10s/30s) backoff window has already EXPIRED — so every re-walk re-enqueues the
// dependent and triggers a new 30-65s runner cycle, forever.
//
// The fix: track the ANCESTOR LIFECYCLE STATE KEY at each attempt. A speculative dependent
// should only be re-attempted when its unmerged ancestors have MADE PROGRESS (their lifecycle
// states changed). If the ancestor state is unchanged since the last attempt, the dependent
// is skipped regardless of the time window — the skip is event-driven on ancestor progress,
// never time-capped. The per-spec `ancestorStateKey` is a stable string encoding the relevant
// unmerged-ancestor lifecycle states. When ANY ancestor advances (CI passes, PR merges, etc.)
// the key changes → the dependent is re-eligible.
//
// Together: (1) time-based window guards rapid notification storms; (2) ancestor-state-key
// guards run-cycle hot-loops where each cycle takes longer than the time window.

import { recoverableRetryDelayMs } from "../merge/retrySchedule.js";

interface HeldEntry {
  /** Consecutive HELD count for this spec (1-based; resets when the spec stops being held). */
  holds: number;
  /** Wall-clock ms before which a re-drive of this spec must be SKIPPED (spaced). */
  nextEligibleAtMs: number;
  /**
   * The ancestor lifecycle state key at the LAST attempt (the stable string the gate compared
   * on the prior walk). A re-drive is suppressed until this key CHANGES (ancestor progressed)
   * OR the time window elapses AND the key changes. Set on `recordHeld` and cleared on `clear`.
   */
  ancestorStateKey: string | undefined;
  /**
   * The project this spec belongs to — recorded so `retainForProject` can evict a project's
   * dead entries WITHOUT touching another project's live ones (the walker's backoff instance is
   * a long-lived singleton shared across every project it walks; spec ids are globally unique but
   * eviction is per-project because a walk only ever sees ONE project's live spec set). Undefined
   * for callers that do not project-scope (the separate percolation `heldBackoff`, which clears
   * its own entries and is never pruned by `retainForProject`).
   */
  projectId: string | undefined;
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
   * True iff the ancestors have made PROGRESS since the last attempt for `specId`.
   * "Progress" means the `currentAncestorStateKey` differs from the key recorded at the
   * last attempt (the ancestor lifecycle states changed — CI passed, PR merged, etc.).
   *
   * Returns true (allow re-drive) when:
   *   - there is no prior attempt record for this spec (first attempt);
   *   - the ancestor state key changed (ancestor progressed — re-drive warranted);
   * Returns false (suppress re-drive) when the key is unchanged (ancestor has not moved).
   */
  ancestorProgressed(specId: string, currentAncestorStateKey: string): boolean {
    const entry = this.entries.get(specId);
    if (entry === undefined || entry.ancestorStateKey === undefined) {
      return true;
    }
    return entry.ancestorStateKey !== currentAncestorStateKey;
  }

  /**
   * Record that `specId` was HELD or attempted this pass: bump its consecutive-hold count,
   * set the next-eligible timestamp the recoverable backoff curve dictates (3s → 10s → 30s
   * → 60s, clamped), and record the ancestor state key so the ancestor-progress gate can
   * detect when the ancestor advances. Returns the chosen delay (for logging/observability).
   */
  recordHeld(
    specId: string,
    opts?: { ancestorStateKey?: string; projectId?: string },
  ): { holds: number; delayMs: number } {
    const prior = this.entries.get(specId);
    const holds = (prior?.holds ?? 0) + 1;
    const delayMs = recoverableRetryDelayMs(holds);
    this.entries.set(specId, {
      holds,
      nextEligibleAtMs: this.now() + delayMs,
      ancestorStateKey: opts?.ancestorStateKey ?? prior?.ancestorStateKey,
      projectId: opts?.projectId ?? prior?.projectId,
    });
    return { holds, delayMs };
  }

  /**
   * Re-arm the backoff window from NOW with the current ancestor state key — called when
   * the time window elapsed but the ancestor has NOT progressed. This resets the window
   * FROM NOW (not from the original enqueue time), so the dependent stays suppressed until
   * the ancestor actually advances or the new window elapses.
   */
  rearmWindow(specId: string, ancestorStateKey: string, projectId?: string): void {
    const prior = this.entries.get(specId);
    const holds = prior?.holds ?? 1;
    const delayMs = recoverableRetryDelayMs(holds);
    this.entries.set(specId, {
      holds,
      nextEligibleAtMs: this.now() + delayMs,
      ancestorStateKey,
      projectId: projectId ?? prior?.projectId,
    });
  }

  /**
   * Clear `specId`'s held state — call when the spec STOPS being held (it absorbed,
   * re-executed, replanned, was unchanged/skipped). A recovered spec must start fresh so a
   * later genuine hold gets the full curve, not a stale long delay.
   */
  clear(specId: string): void {
    this.entries.delete(specId);
  }

  /**
   * BOUNDED-MAP EVICTION (leak fix, issue #1072 F1). Drop every entry that belongs to
   * `projectId` whose spec is NOT in `liveSpecIds` — the set of the project's specs that
   * still need spacing (per the caller: specs whose DAG snapshot phase is `pending` /
   * `in_flight` — i.e. `specs.status` is still open / non-terminal). A spec that reached a terminal
   * DAG phase (`done`/merged, or a terminal spec-status like halted/cancelled/needs_attention)
   * or was DELETED, or a project that went non-active (empty live set), frees its entry, so the
   * map is bounded by live in-flight speculation, never by the cumulative count of specs the
   * long-lived worker ever drove.
   *
   * Eviction is DAG-PHASE / spec-status driven, never wall-clock, and never the lifecycle
   * ladder (an OPEN spec with a halted latest run is lifecycle=`blocked` but DAG phase
   * `pending`, so it is RETAINED — see issue #1072): entries leave only when the spec's DAG
   * phase says it no longer speculates (progress-based, timeout-eradication safe).
   * Only THIS project's entries are considered — another project's live entries (or the
   * percolation instance's project-less entries) are untouched. Returns the count evicted
   * (for observability logging).
   */
  retainForProject(projectId: string, liveSpecIds: ReadonlySet<string>): number {
    let evicted = 0;
    for (const [specId, entry] of this.entries) {
      if (entry.projectId === projectId && !liveSpecIds.has(specId)) {
        this.entries.delete(specId);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** The number of tracked entries — the live bound (used by observability + tests). */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Compute a stable string key encoding the lifecycle states of a set of unmerged ancestor
 * specs. The key changes whenever ANY ancestor advances (CI passes, PR merges, state changes).
 * Used by the ancestor-progress gate to distinguish "ancestor made progress" from "no change".
 *
 * The key is the sorted `specId:state` pairs joined by `|` — stable regardless of iteration
 * order, and unique per combination of (specId, lifecycleState) pairs.
 */
export function ancestorLifecycleKey(
  unmergedAncestorSpecIds: ReadonlyArray<string>,
  lifecycleBySpecId: ReadonlyMap<string, { state: string }>,
): string {
  return unmergedAncestorSpecIds
    .map((id) => `${id}:${lifecycleBySpecId.get(id)?.state ?? "absent"}`)
    .sort()
    .join("|");
}
