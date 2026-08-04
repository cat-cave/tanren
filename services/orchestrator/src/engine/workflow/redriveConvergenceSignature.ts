// The SHARED convergence-signature rules for the `dag.spec.redriven` history — used by
// BOTH history readers (the planner path's `redriveHistoryReader.ts` and the worker orphan
// path's `worker/orphanConsecutiveReader.ts`).
//
// WHY IT IS SHARED. These two readers have drifted apart before: PR #709 added the
// prober-resume source filter to the planner reader only, and the orphan reader kept
// folding window-pause resumes into its history until audit finding D1 caught it. The rules
// are small and identical, so they live in ONE place and both readers call them — a new
// exempt source or a change to the signature axis cannot land in one reader and miss the
// other.

/**
 * `dag.spec.redriven` sources that are NOT structural evidence about convergence, and must
 * be excluded from every convergence history.
 *
 * Both members describe a spec that is WAITING, not a spec that FAILED:
 *
 *   - `prober_resume` (audit finding #13) — the window-pause prober's atomic spec flip from
 *     `in_flight` → `open`. It carries a synthetic `failureCode: "usage_limit"` only because
 *     the spec pair-schema requires SOME code for an `open` flip. Folded into the history it
 *     reads as "a new state appeared between two structural re-drives" — the
 *     `internal, usage_limit, internal` sequence that defeats cycle detection and masks a
 *     genuinely stuck spec.
 *   - `precondition_block` — a run blocked on a NAMED external condition (an unseeded
 *     credential, an unreachable runner, a control plane refusing writes), re-driven on a
 *     cadence because the next attempt IS the probe. Counting the wait would let waiting for
 *     a credential MANUFACTURE the fixed point that parks the spec — precisely the live
 *     defect this whole mechanism exists to fix.
 *
 * Everything else (absent source ⇒ the default `workflow_redrive`) IS structural and counts.
 */
export const NON_STRUCTURAL_REDRIVE_SOURCES: ReadonlySet<string> = new Set(["prober_resume", "precondition_block"]);

/** Whether a `dag.spec.redriven` row's `payload.source` excludes it from convergence history. */
export function isNonStructuralRedriveSource(source: string | undefined): boolean {
  return source !== undefined && NON_STRUCTURAL_REDRIVE_SOURCES.has(source);
}

/**
 * The fixed-point signature for ONE historical `dag.spec.redriven` row.
 *
 * Prefers the FINE-GRAINED `cause` and falls back to the broad `failureCode`. That order is
 * the whole point of the change: on a live instance 93% of run failures classified as the
 * catch-all `internal`, and since a run failure carries no `workSignature` the code WAS the
 * entire signature — so an SSH outage, a missing GitHub credential and a control-plane 500
 * read as one repeating state and parked the spec as "genuinely stuck". Keying on the cause
 * restores the detector's own premise that a CHANGED signature is progress.
 *
 * The `failureCode` fallback is what makes rows written BEFORE this change still work: they
 * carry no `cause`, so they keep their original code-keyed signature and legacy history
 * still reads exactly as it did.
 */
export function redriveFailureSignature(payload: { cause?: string; failureCode?: string }): string {
  return payload.cause ?? payload.failureCode ?? "";
}
