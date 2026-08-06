// The one classification in `runFailureClassifier.ts` that CANNOT be decided by the error
// class name alone, kept beside it rather than inside it (that file is at its 500-line cap).
//
// See `runFailureClassifier.ts` for the table this refines.

import type { ClassifiedRunFailure } from "./runFailureClassifier.js";

// Statuses that THEMSELVES assert "this will clear, come back later". A precondition is a
// claim that a NAMED external condition becomes true WITHOUT the spec changing, and it buys
// an UNBOUNDED re-drive whose rows are excluded from every convergence history — so the
// claim has to be supported by evidence, not by the transport the failure arrived over.
//
// `RunStateWriteTransportError` is thrown on ANY non-2xx, and a static
// `precondition: "control_plane"` on the class meant a permanent 500 from tanren's own
// defect (which is what `attribution: "tanren"` says it is) was indistinguishable from a
// transient 503 — and looped forever at a fixed 30s cadence with no escalation. The two
// axes contradicted each other on the same row: "our bug" and "clears on its own".
//
// 500 is DELIBERATELY not here. It is ambiguous — a transient internal blip or a permanent
// defect — and ambiguity has to resolve toward the bounded path: without a precondition a
// transient 500 STILL recovers unattended (the convergence detector re-drives while the
// failure keeps changing), while a permanent one reaches a proven fixed point and parks
// instead of looping forever. Nothing is lost and the unbounded case is closed.
const CONTROL_PLANE_TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/**
 * Strip the `control_plane` precondition unless the error's own status asserts a retry.
 *
 * Reads the TYPED field off the known class (the same discipline as
 * {@link explicitRunFailureRetryability}) and fails CLOSED: an unreadable or non-numeric
 * status drops the precondition, because the conservative direction here is the one that
 * can still park. Parking is recoverable — an operator requeue restores the full retry
 * budget — whereas an unbounded probe loop is not observable at all.
 */
export function refineControlPlaneWrite(error: Error, matched: ClassifiedRunFailure): ClassifiedRunFailure {
  const status = (error as Error & { status?: unknown }).status;
  if (typeof status === "number" && CONTROL_PLANE_TRANSIENT_STATUSES.has(status)) return matched;
  const { precondition: _unsupported, ...withoutPrecondition } = matched;
  return withoutPrecondition;
}
