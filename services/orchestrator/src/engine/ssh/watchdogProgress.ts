// WATCHDOG WORK-SIGNATURE PROGRESS — the backstop that closes the genuine-hang gap in the
// ActivityWatchdog (feedback_no_timeouts_progress_based, BINDING). The watchdog's primary
// signal is streamed output + an out-of-band liveness probe, both of which reset on ANY sign
// of life. That correctly NEVER kills working work — but on its own it cannot distinguish a
// process that is ALIVE-AND-ADVANCING from one that is ALIVE-BUT-WEDGED (an infinite loop
// spewing BYTE-IDENTICAL output forever, or burning CPU / touching files with no NEW work).
// The wedged-busy case reads "alive" forever and would run TRULY FOREVER with no escalation.
//
// This module adds a PROGRESS assessment LAYERED over liveness — using the convergence
// philosophy, NOT a clock. On the existing probe poll CADENCE (a legitimate interval, never a
// deadline) the substrate snapshots a WORK SIGNATURE of the exec (a fold of the NEW DISTINCT
// OUTPUT since the prior snapshot and the remote WORKSPACE signature) and feeds the SEQUENCE
// of signatures into the SAME fixed-point notion the rest of the engine uses
// (assessStructuralProgress, the convergenceDetector). A signature that keeps CHANGING (new
// distinct output OR an advancing workspace) is genuine progress -> continue UNBOUNDED (the
// common case — never kill working work). A signature that is a FIXED POINT (no new distinct
// output AND no workspace advance across successive checks — no NEW distinct work) is a
// genuine wedge -> SURFACE a recoverable stall.
//
// KEY (so a reviewer and the architecture-timeouts lint both see it): the trigger is
// signature IDENTITY (non-advancement of a work signature), NOT elapsed time. A process
// emitting genuinely-new output / advancing the workspace resets it forever, no matter how
// long it has run. The poll cadence is a legitimate interval. There is no quiet-window, no
// duration threshold, no attempt cap — the decision is purely the convergence detector's
// structural read over the work-signature history.

import { createHash } from "node:crypto";
import { type AttemptSignature, assessStructuralProgress } from "../workflow/convergenceDetector.js";

// The trailing window of work signatures the fixed-point read scans, bounded to the
// convergence detector's own cycle window. NOT an attempt cap and NOT a give-up budget: the
// command runs UNBOUNDED while the signature advances regardless of how many checks elapse;
// the window only bounds how far back a RECURRENCE counts as evidence of a wedge (so a single
// ancient identical snapshot, long before later genuine advancement, never spuriously fires).
// A still-advancing signature trajectory of any length is always progress.
export const WORK_SIGNATURE_WINDOW = 8;

// Fold the recent OUTPUT CONTENT and the remote WORKSPACE signature into one stable work-state
// fingerprint. `outputContent` is the distinctRecentOutput summary of the output seen since the
// prior snapshot; `workspaceSignature` is whatever the liveness probe reported (e.g. the newest
// workspace mtime). An `undefined` workspace means the runner was UNREACHABLE this tick — we
// fold a fixed sentinel so an unreachable runner with no NEW distinct output reads as a
// NON-advancing signature (the dead/zombied case), while genuinely-new output alone still
// advances the fingerprint.
export function workSignature(outputContent: string, workspaceSignature: string | undefined): string {
  const hash = createHash("sha256");
  hash.update(outputContent);
  hash.update(" ");
  hash.update(workspaceSignature ?? " unreachable");
  return hash.digest("hex");
}

// The DISTINCT-CONTENT summary of the output that arrived SINCE the prior snapshot — the
// rate-independent "is there NEW distinct work?" signal fed into workSignature. `priorLen` is
// how many chars of the combined stdout+stderr had already been snapshotted; we look only at
// the increment [priorLen, end). We DEDUP the increment's non-blank lines so the signal is
// independent of HOW FAST the process repeats: a wedged loop spewing the SAME line — whether 1
// copy or 1000 copies this tick — collapses to the SAME distinct set -> an unchanging
// signature. A genuinely-streaming process emits NEW distinct lines -> a changing set ->
// advancement. Returns the new combined length too, so the caller advances its `priorLen`.
export function distinctRecentOutput(combined: string, priorLen: number): { content: string; length: number } {
  const increment = priorLen < combined.length ? combined.slice(priorLen) : "";
  const distinct = [...new Set(increment.split("\n").filter((line) => line.length > 0))].sort();
  return { content: distinct.join("\n"), length: combined.length };
}

// Append a work signature to a trailing history, clamped to {@link WORK_SIGNATURE_WINDOW}.
// Clamping keeps the in-memory history bounded WITHOUT being an attempt cap (the window is the
// cycle look-back, not a budget — a still-advancing trajectory of any length is progress).
export function appendWorkSignature(history: ReadonlyArray<string>, signature: string): string[] {
  const next = [...history, signature];
  return next.length > WORK_SIGNATURE_WINDOW ? next.slice(next.length - WORK_SIGNATURE_WINDOW) : next;
}

// Map a raw work-signature history (oldest->newest, the just-snapshotted latest included) onto
// the convergence detector's `AttemptSignature` shape. The work signature IS both the failure
// axis and the observable "work" axis: an IDENTICAL signature across a poll-cadence-spaced
// check is observed-identical work (the detector's strongest fixed-point evidence — no NEW
// distinct work), and a DIFFERENT signature is genuinely different observable output
// (progress). There is no magnitude — the work either advances (new fingerprint) or repeats.
function toAttemptHistory(signatures: ReadonlyArray<string>): AttemptSignature[] {
  return signatures.map((signature) => ({ failureSignature: signature, workSignature: signature }));
}

// Is the exec WEDGED — its work signature at a FIXED POINT (non-advancing) across the trailing
// checks? Given the work-signature history (oldest->newest, the latest snapshot included),
// returns `true` iff the SHARED convergence detector reads a fixed point: the identical work
// signature persisting / cycling with no new distinct work. A first snapshot, or a CHANGING
// (advancing) signature, reads as progress -> `false` (continue UNBOUNDED). PURE (no I/O, no
// clock) so it is reproducible + property-testable — the decision is signature identity, never
// elapsed time.
export function isWedgedNonAdvancing(history: ReadonlyArray<string>): boolean {
  return assessStructuralProgress(toAttemptHistory(history)) === "fixed_point";
}
