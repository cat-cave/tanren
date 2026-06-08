// Finding constructors shared by the spec-implementation loop
// (docs/roadmap/spec-loop-redesign.md). A failing deterministic gate becomes a P0
// FINDING (not a halt) so it joins the triage set alongside the auditor + demo
// findings. Kept here so subtaskLoop.ts stays under the 500-line architecture cap.
import type { Finding } from "../contracts/findings.js";
import type { GateOutcome } from "./gate/index.js";

/**
 * Turn a failed SPEC GATE (tier-2: tests + full checks) into a P0 FINDING. A CI failure
 * is irrecoverable for the current diff (build/test broken), so it is P0 — the triage
 * routes it to a fix-in-spec task (P0 never defers to a new spec). The id is stable
 * (`gate-<tier>-<step>`) so a recurring gate failure dedupes across loops, which is
 * exactly what the convergence answerer reasons over.
 */
export function gateFindings(gate: Extract<GateOutcome, { passed: false }>): Finding {
  const { failure } = gate;
  const exit = failure.exitCode === null ? "no exit code (timed out or substrate failure)" : `exit ${failure.exitCode}`;
  return {
    id: `gate-${failure.tier}-${failure.failedStep}`,
    severity: "P0",
    title: `Spec gate tier "${failure.tier}" failed at step "${failure.failedStep}"`,
    body: `The deterministic spec gate (${failure.when}) failed at step "${failure.failedStep}" with ${exit}. The tree does not build/test; fix it in this spec.`,
  };
}
