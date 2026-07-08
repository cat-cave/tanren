// Finding constructors shared by the spec-implementation loop
// (docs/roadmap/spec-loop-redesign.md). A failing deterministic gate becomes a P0
// FINDING (not a halt) so it joins the triage set alongside the auditor + demo
// findings. Kept here so subtaskLoop.ts stays under the 500-line architecture cap.
import type { Finding } from "../contracts/findings.js";
import {
  type CandidateSpec,
  PersistentlyInvalidSpecError,
  type SpecAudience,
  validateEmittedSpecs,
  type ValidateEmittedSpecsInput,
} from "../forge/specQuality/index.js";
import type { PlanSubtask, TriageWorkItem } from "../answerers/schemas/index.js";
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

// A triage-proposed new spec DROPPED because the spec-quality gate could not make it
// valid within its convergence budget. Parked (surfaced on `triage.completed`) so the
// drop is visible, never silent — mirroring the audit scheduler's dead-letter to
// needs_attention (`audits/scheduler.ts` `autoRouteOrDeadLetter`).
export interface DroppedTriagedSpec {
  id: string;
  title: string;
  severity: RoutedWorkItem["item"]["severity"];
  reason: string;
}

/** The survivor subset (gate-passing) + the dropped-and-parked persistently-invalid specs. */
export interface GateTriagedSpecsResult {
  survivors: ReadonlyArray<RoutedWorkItem>;
  dropped: ReadonlyArray<DroppedTriagedSpec>;
}

/**
 * Gate the triage's NEW-spec routed items through the spec-quality contract before
 * they leave triage, per-item. A spec the gate could not make valid within its
 * convergence budget throws `PersistentlyInvalidSpecError`; under autonomy that spec
 * is an INDEPENDENT audit-derived DAG node (materialized separately), NOT the scaffold
 * BUILD spec and NOT on its critical path — so a single bad proposal must NOT sink the
 * whole run. We CATCH per-spec, DROP just that proposal, and PARK it (returned in
 * `dropped`, surfaced on `triage.completed` for visibility) — mirroring the audit
 * scheduler's `autoRouteOrDeadLetter` (park to needs_attention, never re-throw). The
 * surviving (gate-passing) specs are returned for the caller to materialize; triage
 * completes and the run continues. A no-op (returns all specs, none dropped) when no
 * validator is wired or no item routed to a spec.
 */
export async function gateTriagedSpecs(
  newSpecs: ReadonlyArray<RoutedWorkItem>,
  gate: TriageSpecValidator | undefined,
): Promise<GateTriagedSpecsResult> {
  if (gate === undefined || newSpecs.length === 0) return { survivors: newSpecs, dropped: [] };
  const survivors: RoutedWorkItem[] = [];
  const dropped: DroppedTriagedSpec[] = [];
  for (const routed of newSpecs) {
    try {
      await validateEmittedSpecs({
        specs: [triagedSpecToCandidate(routed, gate.audience)],
        validator: gate.validator,
        ...(gate.reviseSpec !== undefined && { reviseSpec: gate.reviseSpec }),
      });
      survivors.push(routed);
    } catch (error) {
      // Only a PERSISTENTLY-invalid spec degrades gracefully; any OTHER error
      // (transient provider/DB fault) propagates so the run's normal fail-closed
      // classification/retry applies — we never swallow an unknown throw here.
      if (!(error instanceof PersistentlyInvalidSpecError)) throw error;
      dropped.push({
        id: routed.item.id,
        title: routed.item.title,
        severity: routed.item.severity,
        reason: error.lastAnswer?.revisionGuidance ?? error.message,
      });
    }
  }
  return { survivors, dropped };
}

/** The `triage.completed` item + droppedSpecs payload pieces, derived from the gate
 * result: the gate-dropped proposals leave `items` (surfaced in `droppedSpecs` instead)
 * so the timeline shows exactly what materialized vs. what was parked. */
export function buildTriageCompletedPayloadPieces(
  routed: ReadonlyArray<RoutedWorkItem>,
  gated: GateTriagedSpecsResult,
): {
  items: Array<{
    id: string;
    kind: RoutedWorkItem["item"]["kind"];
    route: RoutedWorkItem["route"];
    severity: RoutedWorkItem["item"]["severity"];
    title: string;
    findingIds: string[];
  }>;
  droppedSpecs: DroppedTriagedSpec[];
} {
  const droppedIds = new Set(gated.dropped.map((d) => d.id));
  return {
    items: routed
      .filter((r) => !droppedIds.has(r.item.id))
      .map((r) => ({
        id: r.item.id,
        kind: r.item.kind,
        route: r.route,
        severity: r.item.severity,
        title: r.item.title,
        findingIds: [...r.item.findingIds],
      })),
    droppedSpecs: [...gated.dropped],
  };
}

/**
 * Map a triaged work item onto the `NewSpecRequest` the caller materializes as a DAG spec.
 * The optional `originTriageTaskId` stamps the routing provenance (Claude RA2) — the
 * `task_id` of the triage stage that emitted the item, so the created spec's
 * `origin_triage_task_id` column carries the routing trail.
 */
export function routedToNewSpec(
  r: {
    item: {
      id: string;
      title: string;
      body: string;
      severity: NewSpecRequest["severity"];
      findingIds: ReadonlyArray<string>;
    };
  },
  originTriageTaskId?: string,
): NewSpecRequest {
  return {
    id: r.item.id,
    title: r.item.title,
    body: r.item.body,
    severity: r.item.severity,
    findingIds: [...r.item.findingIds],
    ...(originTriageTaskId !== undefined && { originTriageTaskId }),
  };
}

/**
 * apex v79/v80 loop closure — fail-closed guard on the TRIAGE answer's coverage.
 * The triage agent must account for every input finding via a workItem's `findingIds`
 * subsumption trail; otherwise `summarizeTriageRouting` would honor triage's answer as
 * if the uncovered findings never existed (the "passed" arrow when tasksHere is empty
 * of routed items), silently dropping findings into a black hole.
 *
 * Two shapes are gated here (Codex critic RA1 — the initial v79 fix only caught the
 * empty-workItems case, so a PARTIAL cover was still a silent drop):
 * - EMPTY workItems on non-empty findings → synthesize a single coverage-gap P0
 *   subsuming every finding.
 * - PARTIAL coverage (workItems present, but the union of their `findingIds` misses
 *   one or more input finding ids) → APPEND a coverage-gap P0 subsuming ONLY the
 *   uncovered findings. The triage agent's kept workItems pass through unchanged so
 *   its per-item subsumption trail is preserved; only the gap is filled.
 *
 * Full coverage (empty findings, or every finding id appears in some workItem's
 * `findingIds`) passes through unchanged.
 */
export function ensureFindingCoverage(
  workItems: ReadonlyArray<TriageWorkItem>,
  findings: ReadonlyArray<Finding>,
  triageTaskId: string,
): ReadonlyArray<TriageWorkItem> {
  if (findings.length === 0) return workItems;
  const covered = new Set<string>();
  for (const item of workItems) {
    for (const id of item.findingIds) covered.add(id);
  }
  const uncovered = findings.filter((f) => !covered.has(f.id));
  if (uncovered.length === 0) return workItems;
  const isPartial = workItems.length > 0;
  const preamble = isPartial
    ? `Fail-closed synthetic P0: the triage agent produced ${workItems.length} workItem(s) but their subsumption trail (\`findingIds\`) omitted ${uncovered.length} of ${findings.length} input finding(s), which would silently drop them (a black hole). The kept workItems pass through unchanged; the uncovered findings are subsumed here so the loop re-iterates.`
    : `Fail-closed synthetic P0: the triage agent produced empty workItems while ${findings.length} finding(s) were present, which would silently drop them (a black hole). Each finding is subsumed here so the loop re-iterates.`;
  const gapItem: TriageWorkItem = {
    id: `triage-coverage-gap-${triageTaskId}`,
    kind: "task" as const,
    severity: "P0" as const,
    title: isPartial
      ? "Triage omitted findings from its subsumption trail (partial coverage)"
      : "Triage returned no work items on non-empty findings",
    body: `${preamble} Uncovered findings: ${uncovered.map((f) => `[${f.severity}] ${f.id}: ${f.title}`).join("; ")}`,
    findingIds: uncovered.map((f) => f.id),
  };
  return isPartial ? [...workItems, gapItem] : [gapItem];
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
