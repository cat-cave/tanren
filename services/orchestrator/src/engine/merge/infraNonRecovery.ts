// SUSTAINED-INFRA-NON-RECOVERY — the PROGRESS-BASED replacement for the merge ceilings'
// fixed attempt COUNTS (feedback_no_timeouts_progress_based, BINDING). The three merge
// infra-hold guards (`coordinator.ts` transient-drive hold, `recoverableDriveHold.ts`,
// `batchInfraHoldCeiling.ts`) used to fire their loud `infra_blocked` alert on a fixed
// `attempt === N` count. That is a give-up COUNTER — forbidden: "10 minutes / 5 tries is
// nothing to an AI agent". This module reframes the SAME loud-alert-but-keep-re-driving
// behavior off the count and onto a PROGRESS signal: the alert fires only when the SAME
// infra failure SIGNATURE is genuinely NOT recovering — i.e. it persists with no progress
// across the (backoff-spaced) re-drives. That is exactly the fixed-point notion the
// convergence detector already distills, so this is a thin wrapper over
// `assessStructuralProgress` keyed on the infra-failure signature history.
//
// NOT a behavior change: at the alert the caller STILL keeps the entry queued + re-drives
// with the longer backoff (never abandons). A CHANGING failure signature (a recovering /
// shifting blip) reads as PROGRESS and never alerts — it just keeps recovering quietly. The
// per-entry attempt COUNT is retained PURELY as telemetry (the emitted `attempts` field),
// never as the control-flow trigger.

import { type AttemptSignature, assessStructuralProgress } from "../workflow/convergenceDetector.js";

/**
 * The trailing infra-failure-signature history the non-recovery read reasons over, bounded
 * to the convergence detector's cycle window. NOT an attempt cap: the loop re-drives
 * UNBOUNDED regardless of length; the window only bounds how far back a signature recurrence
 * counts as evidence of a non-recovering fixed point (so a single ancient blip, long before
 * sustained recovery, never spuriously re-triggers). A signature that keeps CHANGING (the
 * recovering case) is always progress, no matter the window.
 */
export const INFRA_SIGNATURE_WINDOW = 8;

/**
 * Map a raw infra-failure history of stable signature strings (oldest→newest, the latest
 * included) onto the convergence detector's `AttemptSignature` shape. The infra failure's
 * stable identity IS both the failure axis AND the observable "work" axis here — the
 * re-drive PRODUCED the identical failure, so an identical signature across a backoff-spaced
 * re-drive is observed-identical work (the detector's strongest fixed-point evidence), and a
 * DIFFERENT signature is genuinely different observable output (progress). There is no
 * separate magnitude — an infra hold either recurs identically or it shifts.
 */
function toAttemptHistory(signatures: ReadonlyArray<string>): AttemptSignature[] {
  return signatures.map((signature) => ({ failureSignature: signature, workSignature: signature }));
}

/**
 * Is the infra failure SUSTAINED-NON-RECOVERING — the loud-alert trigger that replaces the
 * fixed attempt count? Given the trailing signature history (oldest→newest, the just-recorded
 * latest included), return `true` iff the convergence detector reads a FIXED POINT: the same
 * infra failure persisting / cycling with no progress across the re-drives. A first hold, or a
 * CHANGING / recovering signature, reads as progress → `false` (keep recovering quietly, no
 * alert). PURE (no I/O, no clock) — the durable signature history is supplied by the caller's
 * `HoldCeilingStore`, so the decision survives a restart exactly as the old count did.
 */
export function isSustainedInfraNonRecovery(signatures: ReadonlyArray<string>): boolean {
  return assessStructuralProgress(toAttemptHistory(signatures)) === "fixed_point";
}

/**
 * Append `signature` to a trailing history, clamped to {@link INFRA_SIGNATURE_WINDOW}. The
 * store persists the returned array; passing it back through {@link isSustainedInfraNonRecovery}
 * yields the alert decision. Clamping keeps the persisted JSON bounded WITHOUT being an attempt
 * cap (the window is the cycle look-back, not a give-up budget — a still-changing signature
 * trajectory of any length is always progress).
 */
export function appendInfraSignature(history: ReadonlyArray<string>, signature: string): string[] {
  const next = [...history, signature];
  return next.length > INFRA_SIGNATURE_WINDOW ? next.slice(next.length - INFRA_SIGNATURE_WINDOW) : next;
}
