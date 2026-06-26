// Finding constructors shared by the spec-implementation loop
// (docs/roadmap/spec-loop-redesign.md). A failing deterministic gate becomes a P0
// FINDING (not a halt) so it joins the triage set alongside the auditor + demo
// findings. Kept here so subtaskLoop.ts stays under the 500-line architecture cap.
import type { Finding } from "../contracts/findings.js";
import {
  type CandidateSpec,
  type SpecAudience,
  validateEmittedSpecs,
  type ValidateEmittedSpecsInput,
} from "../forge/specQuality/index.js";
import type { PlanSubtask } from "../answerers/schemas/index.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import type { RoutedWorkItem } from "./loopPolicy.js";
import type { NewSpecRequest } from "./subtaskLoop.js";
import { BOOTSTRAP_GATE_TIER, CI_CONFIG_GATE_TIER, type GateOutcome } from "./gate/index.js";
import { evidenceInsufficientDirective, failedStepOutputTail } from "./subtaskInnerLoop.js";

/**
 * Turn a failed SPEC GATE (tier-2: tests + full checks) into a P0 FINDING. A CI failure
 * is irrecoverable for the current diff (build/test broken), so it is P0 — the triage
 * routes it to a fix-in-spec task (P0 never defers to a new spec). The id is stable
 * (`gate-<tier>-<step>`) so a recurring gate failure dedupes across loops, which is
 * exactly what the convergence answerer reasons over.
 */
export function gateFindings(gate: Extract<GateOutcome, { passed: false }>): Finding {
  const { failure } = gate;
  // An INVALID `.tanren/ci.yml` failure (the fail-closed gate-config boundary) is a
  // DIFFERENT P0 than a broken tree: the repo's gate CONFIG is malformed, so the loop
  // must fix the CONFIG (not the code). Name it precisely + carry the validation
  // issues (captured in the synthetic step's outputTail) so the convergence answerer
  // fixes the config in-place rather than chasing a phantom build failure. The stable
  // id (`gate-tanren-ci-config-validate`) dedupes a recurring invalid config across loops.
  if (failure.tier === CI_CONFIG_GATE_TIER) {
    const issues = failure.steps[0]?.outputTail ?? failure.failedStep;
    return {
      id: `gate-${failure.tier}-${failure.failedStep}`,
      severity: "P0",
      title: "The repo's `.tanren/ci.yml` is invalid",
      body: `The native gate config (\`.tanren/ci.yml\`) failed to validate, so the ${failure.when} gate cannot run (fail-closed — an invalid gate config is NOT a pass). Fix the config in this spec: ${issues}`,
    };
  }
  // A WRITER-AUTHORED scaffold deps-install failure (the project's `just bootstrap`
  // exited nonzero — e.g. pnpm's `ERR_PNPM_IGNORED_BUILDS`). This is the writer's OWN
  // package manifest / lockfile, so the loop must FIX THE SCAFFOLD (not chase a phantom
  // build failure). Name it precisely + feed the writer the bootstrap output (captured
  // in the synthetic step's outputTail) so the re-author addresses the concrete error.
  // The stable id (`gate-tanren-bootstrap-deps-install`) dedupes a recurring bootstrap
  // failure across loops, so the convergence answerer bounds the self-heal loop. The
  // mise toolchain provision is NOT routed here — it halts terminally at workspace-prep.
  if (failure.tier === BOOTSTRAP_GATE_TIER) {
    const output = failure.steps[0]?.outputTail ?? failure.failedStep;
    const exit =
      failure.exitCode === null ? "no exit code (timed out or substrate failure)" : `exit ${failure.exitCode}`;
    return {
      id: `gate-${failure.tier}-${failure.failedStep}`,
      severity: "P0",
      title: "The scaffold's `just bootstrap` (deps install) failed",
      body:
        `The project's deps install (\`just bootstrap\`) failed during the ${failure.when} gate with ${exit}, so ` +
        `the tree cannot build or test (fail-closed — an unbuildable tree is NOT a pass). This is almost always a ` +
        `defect in the scaffold you authored (e.g. a \`package.json\` that does not install cleanly). Fix the ` +
        `scaffold in this spec so \`just bootstrap\` succeeds. Bootstrap output: ${output}`,
    };
  }
  const exit = failure.exitCode === null ? "no exit code (timed out or substrate failure)" : `exit ${failure.exitCode}`;
  // Carry the failed step's captured output (apex-v36 non-convergence fix): the spec gate
  // already captured up to 4KB of the failing step's stderr/stdout in `outputTail`. This is
  // the ACTUAL error — e.g. prettier naming the unformatted files + "Run Prettier with
  // --write to fix" — and is the load-bearing rework context. Without it the writer reworks
  // BLIND ("the tree does not build/test") and re-produces the SAME unformatted output; WITH
  // it the writer fixes the named failure directly (and, for a deterministic fmt/lint
  // failure, runs the project's declared formatter/fix step). This mirrors the fast-tier
  // (`gateReason`) and merge-tier (`mergeGateRejection`) gate steering, which already feed it.
  const output = failedStepOutputTail(failure);
  const detail = output === "" ? "" : `\nGate output (last lines):\n${output}`;
  // EVIDENCE-INSUFFICIENT (apex v57 task #64): when the gate failed because the step
  // exited 0 but produced no positive proof of its declared contract, prepend the
  // SPECIFIC contract-violation diagnosis. The class name (`gate-evidence-insufficient-<reason>`)
  // is the stable dedup key the spec-level convergence detector keys off. The finding
  // id stays stable (`gate-<tier>-<step>`) so a recurring failure of the same step
  // still dedupes — the v57 fix turns an 8h convergence loop into a 1-iteration fix.
  const evidenceDirective = evidenceInsufficientDirective(failure);
  const evidencePrefix = evidenceDirective === undefined ? "" : `${evidenceDirective}\n`;
  return {
    id: `gate-${failure.tier}-${failure.failedStep}`,
    severity: "P0",
    title: `Spec gate tier "${failure.tier}" failed at step "${failure.failedStep}"`,
    body:
      `${evidencePrefix}The deterministic spec gate (${failure.when}) failed at step "${failure.failedStep}" with ${exit}. ` +
      `Fix it in this spec — if it is a deterministic formatting/lint failure, run the project's declared ` +
      `format/fix step (the one its lifecycle/justfile defines) so the gate passes; do NOT re-emit the same ` +
      `output unchanged.${detail}`,
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
export type TriageSpecValidator = Pick<ValidateEmittedSpecsInput, "validator" | "reviseSpec"> & {
  // The LEGIBILITY audience the triaged specs are judged against (specQuality
  // `SpecAudience`). A TEMPLATE-CREATION build sets `technical` so its internal
  // (scaffold / gate / mutation / manifest) specs are NOT rejected for legitimate
  // domain vocabulary. Absent ⇒ `product` (the strict bar for a normal product).
  audience?: SpecAudience;
};

// Map one triaged `kind: spec` work item onto the validator's `CandidateSpec` shape.
// The item carries no separate acceptance criteria (the body is the authored unit),
// so the contract judges title + body; criteria are left empty for the validator to
// flag if the unit is not demonstrable. `audience` scopes the LEGIBILITY bar (a
// template-build's technical specs vs. a product spec).
function triagedSpecToCandidate(routed: RoutedWorkItem, audience: SpecAudience | undefined): CandidateSpec {
  return {
    title: routed.item.title,
    description: routed.item.body,
    acceptanceCriteria: [],
    ...(audience !== undefined && { audience }),
  };
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
    specs: newSpecs.map((routed) => triagedSpecToCandidate(routed, gate.audience)),
    validator: gate.validator,
    ...(gate.reviseSpec !== undefined && { reviseSpec: gate.reviseSpec }),
  });
}

/** Map a triaged work item onto the `NewSpecRequest` the caller materializes as a DAG spec. */
export function routedToNewSpec(r: {
  item: {
    id: string;
    title: string;
    body: string;
    severity: NewSpecRequest["severity"];
    findingIds: ReadonlyArray<string>;
  };
}): NewSpecRequest {
  return {
    id: r.item.id,
    title: r.item.title,
    body: r.item.body,
    severity: r.item.severity,
    findingIds: [...r.item.findingIds],
  };
}

// Turn the kept-in-spec triage items into the planner-steering rejection record routed
// through the SAME planner rejectionHistory the checker/auditor feedback uses, so the
// re-plan addresses the concrete root causes. `behaviorIdsFailed` carries the work-item
// ids (the dedup trail).
export function triageToRejection(
  tasksHere: ReadonlyArray<{ item: { id: string; title: string; body: string } }>,
  subtasks: ReadonlyArray<PlanSubtask>,
): PlannerRejectionFeedback {
  return {
    producer: "auditor",
    rejectionReason: tasksHere.map((r) => `${r.item.title}: ${r.item.body}`).join("; "),
    behaviorIdsFailed: tasksHere.map((r) => r.item.id),
    previousSubtasks: subtasks,
  };
}
