// The SHARED payload fields the two disposition appliers stamp onto their lifecycle events
// — the planner path (`plannerRunRedrive.ts`) and the worker orphan path
// (`worker/runFinalize.ts`). Both emit `dag.spec.redriven` / `dag.spec.needs_attention` /
// `run.failed` for the SAME dispositions, so the attribution fields and the
// precondition-block tag are built here once rather than transcribed in two places where
// they could drift (the prober-resume source filter drifted exactly that way once already —
// see `redriveConvergenceSignature.ts`).

import type { ClassifiedRunFailure, RunPrecondition } from "../worker/runFailureClassifier.js";

/**
 * The fine-grained `cause` + the `attribution` (WHOSE bug this is), spread onto every event
 * a classified failure produces.
 *
 * Returns nothing for a FAULTLESS disposition — a merge-stage human-decision halt carries no
 * classified failure, and both payload fields are optional precisely so that case stays
 * clean rather than inventing a placeholder attribution.
 */
export function causeFields(failure: ClassifiedRunFailure | undefined): {
  cause?: ClassifiedRunFailure["cause"];
  attribution?: ClassifiedRunFailure["attribution"];
} {
  return failure === undefined ? {} : { cause: failure.cause, attribution: failure.attribution };
}

/**
 * The PRECONDITION-BLOCK tag for a `dag.spec.redriven` payload.
 *
 * The run is WAITING on a named external condition, not failing at one. The `source` tag is
 * what keeps that wait OUT of the convergence history in BOTH readers — the same exemption
 * `prober_resume` already has, for the same reason. Without it, waiting for a credential
 * would itself become the evidence that parks the spec.
 *
 * A normal structural re-drive gets no `source` at all ⇒ the default `workflow_redrive`,
 * exactly as before this change.
 */
export function preconditionFields(precondition: RunPrecondition | undefined): {
  source?: "precondition_block";
  precondition?: RunPrecondition;
} {
  return precondition === undefined ? {} : { source: "precondition_block", precondition };
}
