// Finding constructors shared by the spec-implementation loop
// (docs/roadmap/spec-loop-redesign.md). A failing deterministic gate becomes a P0
// FINDING (not a halt) so it joins the triage set alongside the auditor + demo
// findings. Kept here so subtaskLoop.ts stays under the 500-line architecture cap.
import type { Finding } from "../contracts/findings.js";
import {
  type CandidateSpec,
  validateEmittedSpecs,
  type ValidateEmittedSpecsInput,
} from "../forge/specQuality/index.js";
import type { RoutedWorkItem } from "./loopPolicy.js";
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

// WORKSTREAM 1 ↔ 2 SEAM — the spec-quality gate over the triage's `kind: spec` items.
// A triaged work item routed to a NEW DAG spec must meet the SAME accomplishable /
// demo-able / non-trivial / legible bar as every other spec-emitter (the contract,
// `forge/specQuality`). The injected validator (resolved per org/project in plannerRun)
// runs `validateEmittedSpecs` over the candidate specs BEFORE they materialize; a
// persistently-invalid spec raises `PersistentlyInvalidSpecError` (the loud
// needs_attention surface) — never a silent commit into the DAG. Absent ⇒ the gate is
// inert (unit/test paths that do not wire a provider validator).
export type TriageSpecValidator = Pick<ValidateEmittedSpecsInput, "validator" | "reviseSpec" | "maxRevisions">;

// Map one triaged `kind: spec` work item onto the validator's `CandidateSpec` shape.
// The item carries no separate acceptance criteria (the body is the authored unit),
// so the contract judges title + body; criteria are left empty for the validator to
// flag if the unit is not demonstrable.
function triagedSpecToCandidate(routed: RoutedWorkItem): CandidateSpec {
  return { title: routed.item.title, description: routed.item.body, acceptanceCriteria: [] };
}

/**
 * Gate the triage's NEW-spec routed items through the spec-quality contract before
 * they leave triage. Propagates `PersistentlyInvalidSpecError` loud on a persistently
 * non-compliant spec. A no-op (returns immediately) when no validator is wired or no
 * item routed to a spec.
 */
export async function gateTriagedSpecs(
  newSpecs: ReadonlyArray<RoutedWorkItem>,
  gate: TriageSpecValidator | undefined,
): Promise<void> {
  if (gate === undefined || newSpecs.length === 0) return;
  await validateEmittedSpecs({
    specs: newSpecs.map((routed) => triagedSpecToCandidate(routed)),
    validator: gate.validator,
    ...(gate.reviseSpec !== undefined && { reviseSpec: gate.reviseSpec }),
    ...(gate.maxRevisions !== undefined && { maxRevisions: gate.maxRevisions }),
  });
}
