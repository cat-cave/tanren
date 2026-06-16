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
// to defer it cheaply (benign, observable), or to skip it silently (inside its backoff window):
//   (1) BACKOFF (the bound): inside its per-spec backoff window ⇒ SKIP silently. The window is
//       armed (`HeldReDriveBackoff.recordHeld`) on EVERY speculative attempt — a cheap defer OR
//       a real enqueue — so a re-drive for ANY reason (incl. the bootstrap-time
//       `AncestorNotReadyError` race the lifecycle view cannot foresee) is spaced on the
//       3s→10s→30s→60s curve. A storm collapses to a handful of attempts, not hundreds.
//   (2) CHEAP PRE-CHECK (the bigger win): an unmerged ancestor below `pr_open` (no published
//       head — the cheap signal the bootstrap assembly would throw `AncestorNotReadyError`) ⇒
//       DEFER without provisioning (emit the benign event, arm the backoff).
//   else PROCEED to the real enqueue (the caller arms the backoff after it lands).
// The backoff never caps the wait, only spaces it, so a dependent is never starved; it stops
// being a candidate once it advances past `pending` (occupies a slot) or merges.

import type { DagLifecycleSnapshot } from "../contracts/dagLifecycle.js";
import type { HeldReDriveBackoff } from "./heldReDriveBackoff.js";
import { firstAncestorWithoutPublishedHead } from "./speculation.js";

/** The gate's decision for a speculative dependent. */
export type AncestorWaitDecision =
  /** Inside the backoff window — skip silently (no event, no provisioning). */
  | { kind: "skip"; remainingMs: number }
  /** An ancestor has no published head — defer cheaply: emit the benign event, no provisioning. */
  | { kind: "defer"; ancestorSpecId: string; ancestorPhase: "pending" | "in_flight"; holds: number; delayMs: number }
  /** Every ancestor has a published head and the window is clear — proceed to the real enqueue. */
  | { kind: "proceed" };

/**
 * Decide a speculative dependent's fate against its per-spec backoff + the cheap ancestor-
 * published-head pre-check (above). Pure aside from the injected `backoff`'s clock/state; the
 * caller acts on the decision (skip/defer-with-event/enqueue) and, on `proceed`, ALSO arms the
 * backoff after the enqueue lands so a later re-drive is spaced.
 */
export function decideAncestorWait(
  backoff: HeldReDriveBackoff,
  specId: string,
  unmergedAncestors: ReadonlyArray<string>,
  lifecycle: DagLifecycleSnapshot,
): AncestorWaitDecision {
  if (backoff.shouldSkip(specId)) {
    return { kind: "skip", remainingMs: backoff.remainingMs(specId) };
  }
  const notReady = firstAncestorWithoutPublishedHead(unmergedAncestors, lifecycle);
  if (notReady !== undefined) {
    const { holds, delayMs } = backoff.recordHeld(specId);
    return { kind: "defer", ancestorSpecId: notReady.ancestorSpecId, ancestorPhase: notReady.phase, holds, delayMs };
  }
  return { kind: "proceed" };
}
