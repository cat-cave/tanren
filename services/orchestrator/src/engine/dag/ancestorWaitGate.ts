// ANCESTOR-NOT-READY RE-DRIVE GATE (apex v35, the runner-alloc hot-loop fix; mirrors #584's
// base-shift `HeldReDriveBackoff`). A speculative dependent enqueue is EXPENSIVE — it allocates
// a runner, mints a scoped token, and clones to jj-assemble the dependent's base from its
// ancestors' real PR-head branches. The live run re-drove ONE dependent ("Upgrade dependencies
// to latest", which depends on ~all other specs) ~516× over a single build (512
// `dag.spec.ancestor_not_ready`; ~516 runner.allocated / credential.scoped_token_minted each):
// PR #576's benign `ancestor_not_ready` re-drive (the spec returns to `open`) re-fired on EVERY
// percolation notification with NO spacing and did the full expensive work each time, just to
// re-discover the ancestor still had not published its head.
//
// This pure gate decides — BEFORE any provisioning — whether to enqueue a speculative dependent,
// to defer it cheaply (benign, observable), or to skip it silently:
//   (1) BACKOFF (notification-storm defense): inside its per-spec backoff window ⇒ SKIP silently.
//       The window is armed on EVERY speculative attempt — a cheap defer OR a real enqueue.
//   (2) CHEAP PRE-CHECK (the bigger win): an unmerged ancestor below `pr_open` (no published
//       head — the cheap signal the bootstrap assembly would throw `AncestorNotReadyError`) ⇒
//       DEFER without provisioning (emit the benign event, arm the backoff).
//   (3) ANCESTOR-PROGRESS CHECK (apex v45, the run-cycle hot-loop fix): when the time window has
//       elapsed but the ancestor lifecycle states are UNCHANGED since the last attempt, the
//       dependent is SKIPPED by re-arming the window from NOW. This makes re-drives event-driven
//       on ancestor progress: only re-attempt when the ancestor has actually ADVANCED (CI passed,
//       PR merged, etc.), not just when enough time has passed. The run-cycle hot-loop arises
//       when each run cycle takes 30-65s (runner alloc + clone + AncestorNotReadyError), longer
//       than the time-based backoff window, so the window is always expired by the next walk.
//       With the progress check: the ancestor at `pr_open` (lifecycle unchanged since last attempt)
//       is recognized as "no progress" → skip. Only when the ancestor advances does the descendant
//       get a fresh speculative attempt.
//   else PROCEED to the real enqueue (the caller arms the backoff + ancestor state key after it
//       lands so a later re-drive is spaced and progress-gated).
//
// The gate never caps the wait, only spaces it (no retry count). A dependent blocked by ancestor
// non-progress is re-eligible the moment its ancestor advances — the walker fires on every
// run-terminal notification, which includes ancestor lifecycle events (CI pass, PR merge).

import type { DagLifecycleSnapshot } from "../contracts/dagLifecycle.js";
import { ancestorLifecycleKey, type HeldReDriveBackoff } from "./heldReDriveBackoff.js";
import { firstAncestorWithoutPublishedHead } from "./speculation.js";

/** The gate's decision for a speculative dependent. */
export type AncestorWaitDecision =
  /** Inside the backoff window OR ancestor has not progressed — skip silently (no event, no provisioning). */
  | { kind: "skip"; remainingMs: number }
  /** An ancestor has no published head — defer cheaply: emit the benign event, no provisioning. */
  | { kind: "defer"; ancestorSpecId: string; ancestorPhase: "pending" | "in_flight"; holds: number; delayMs: number }
  /** Every ancestor has a published head, the window is clear, and the ancestor has progressed — proceed. */
  | { kind: "proceed" };

/**
 * Decide a speculative dependent's fate against its per-spec backoff + ancestor-progress check
 * + the cheap ancestor-published-head pre-check (above). Pure aside from the injected `backoff`'s
 * clock/state; the caller acts on the decision (skip/defer-with-event/enqueue) and, on `proceed`,
 * ALSO arms the backoff + ancestor state key after the enqueue lands so a later re-drive is
 * progress-gated (not just time-gated).
 */
export function decideAncestorWait(
  backoff: HeldReDriveBackoff,
  specId: string,
  unmergedAncestors: ReadonlyArray<string>,
  lifecycle: DagLifecycleSnapshot,
): AncestorWaitDecision {
  // (1) Time-based backoff: inside the window → skip (notification-storm defense).
  if (backoff.shouldSkip(specId)) {
    return { kind: "skip", remainingMs: backoff.remainingMs(specId) };
  }

  // (2) Cheap pre-check: an ancestor without a published head → defer cheaply without provisioning.
  const notReady = firstAncestorWithoutPublishedHead(unmergedAncestors, lifecycle);
  if (notReady !== undefined) {
    const { holds, delayMs } = backoff.recordHeld(specId);
    return { kind: "defer", ancestorSpecId: notReady.ancestorSpecId, ancestorPhase: notReady.phase, holds, delayMs };
  }

  // (3) Ancestor-progress check: all ancestors appear ready (pr_open+) per lifecycle, BUT
  // we may have attempted this before. If the ancestor lifecycle states are UNCHANGED since
  // the last attempt, the ancestor has not progressed — the previous run hit AncestorNotReadyError
  // because the lifecycle was stale (branch not yet pushed) and the situation has not improved.
  // Re-arm the window from NOW and skip: the dependent will be re-eligible when the ancestor
  // advances (its lifecycle state changes) OR the new window elapses AND the ancestor advanced.
  const currentKey = ancestorLifecycleKey(unmergedAncestors, lifecycle.bySpecId);
  if (!backoff.ancestorProgressed(specId, currentKey)) {
    // Ancestor has not moved since the last attempt — skip and re-arm the window from NOW
    // so we don't spin on every walker tick until the ancestor actually advances.
    backoff.rearmWindow(specId, currentKey);
    return { kind: "skip", remainingMs: backoff.remainingMs(specId) };
  }

  return { kind: "proceed" };
}
