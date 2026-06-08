// auditor module for the planner-feedback loop. Runs the typed AuditAnswer schema
// after every subtask has passed its checker pass, and exposes a
// `decideAuditorOutcome` helper that maps the auditor's emitted FINDINGS into the
// rejection-loop branch the subtask loop takes.
//
// SLICE S3 (tanren-owns-the-engine.md §4 + §7): the auditor emits FINDINGS ONLY as its
// decision currency. `decideAuditorOutcome` derives the loop branch from the explicit
// `findings` severity — NOT the legacy `passed`/`recommendedAction` verdict enum:
//   - a P0 finding (irrecoverable) → halt the run,
//   - a P1 finding (blocking, but recoverable by re-planning) → loop back to the planner,
//   - only P2/P3 findings (or none) → pass (the residual polish is handled by the
//     project `auditPosture` at the merge gate — fix-in-place / route-to-DAG).
// This PRESERVES the loop-to-planner behavior (a blocking finding routes back) while
// driving it from findings + severity, not the deleted verdict enum.
import { answererOutputSchemaFor, AuditAnswer } from "../../answerers/schemas/index.js";
import type { PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { type Finding, maxSeverity } from "../../contracts/findings.js";
import { buildAuditorPrompt as buildAuditorPromptText } from "../answererPrompts.js";

// The findings-only closing instruction. The shared body lives in answererPrompts.ts;
// only this schema-specific tail names the auditor's findings currency. S3: the auditor
// DECLARES each defect's severity directly and renders NO pass/fail judgment — the
// project's posture (not the model) decides what blocks the merge.
const AUDITOR_FINDINGS_OUTPUT_INSTRUCTIONS = [
  "Emit your audit as a `findings` list — one entry per concrete defect you found,",
  "each with an EXPLICIT severity: P0 (irrecoverable blocker / data-loss /",
  "build-breaking), P1 (blocking defect that must be reworked), P2 (non-blocking",
  "quality gap worth fixing), P3 (minor polish). Give each a stable slug `id`, a short",
  "`title`, a `body` with enough context to act on, and an optional `fixHint`. Emit an",
  "EMPTY `findings` list when the change is audited-clean — never invent a finding. Do",
  "NOT render a pass/fail/halt judgment yourself: the project's posture decides what a",
  "finding's severity means for the merge.",
];

export interface AuditorSpecContext {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  subtasks: ReadonlyArray<PlanSubtask>;
  // The run base the combined writer change is diffed against. The auditor runs
  // INSIDE the read-only workspace and inspects the change itself (rather than
  // having the full combined diff injected into the prompt).
  baselineSha: string;
}

export interface AuditorInvokeInput {
  context: AuditorSpecContext;
  timeoutMs: number;
  workspace?: string;
}

export interface AuditorInvocationResult {
  verdict: AuditAnswer;
  schemaId: string;
}

export async function invokeAuditor(
  auditor: AnswererAdapter<AuditAnswer>,
  input: AuditorInvokeInput,
): Promise<AuditorInvocationResult> {
  const outputSchema = answererOutputSchemaFor("audit", AuditAnswer);
  const prompt = buildAuditorPrompt(input.context);
  const verdict = await auditor.runAnswerer({
    prompt,
    timeoutMs: input.timeoutMs,
    workspace: input.workspace,
    outputSchema,
  });
  return { verdict, schemaId: outputSchema.name };
}

// Production auditor prompt: the canonical shared body (answererPrompts.ts) with
// the executed-subtasks context mapped down to the common input and the v2-schema
// closing instruction supplied.
export function buildAuditorPrompt(context: AuditorSpecContext): string {
  return buildAuditorPromptText({
    specTitle: context.specTitle,
    specDescription: context.specDescription,
    acceptanceCriteria: context.acceptanceCriteria,
    baselineSha: context.baselineSha,
    subtasks: context.subtasks.map((subtask) => ({
      index: subtask.index,
      title: subtask.title,
      intent: subtask.intent,
      behaviorIds: subtask.behaviorIds,
    })),
    outputInstructions: AUDITOR_FINDINGS_OUTPUT_INSTRUCTIONS,
  });
}

// AuditorDecision encodes the rejection-loop branch. As with the checker, the decision
// is pure so the subtask loop's branching can be tested deterministically without
// re-running the Codex CLI. S3: `action` is findings-derived (a P0 → halt, a P1 →
// loop_to_planner) rather than read off the deleted `recommendedAction` enum.
export type AuditorDecision =
  | { kind: "pass" }
  | {
      kind: "reject";
      action: "loop_to_planner" | "halt";
      reason: string;
      outstandingBehaviorIds: ReadonlyArray<string>;
    };

/**
 * Decide the in-loop rework branch from the auditor's EMITTED findings (S3). The
 * most-severe finding drives the branch:
 *   - P0 (irrecoverable) → halt the run,
 *   - P1 (blocking, recoverable by re-planning) → loop back to the planner,
 *   - P2/P3 only (or no findings) → pass — the residual polish is the project posture's
 *     job at the merge gate (fix-in-place / route-to-DAG), never a rework halt.
 * The rejection `reason`/`outstandingBehaviorIds` are sourced from the blocking findings
 * (their titles + ids) so the planner-rework feedback names the concrete defects. The
 * `reasoning`/`recommendedAction` verdict fields are NO LONGER read for the decision.
 */
export function decideAuditorOutcome(verdict: AuditAnswer): AuditorDecision {
  // The schema defaults `findings` to `[]`; coalesce defensively for a raw (un-parsed)
  // fixture verdict so an absent list reads as audited-clean, never throws.
  const findings: ReadonlyArray<Finding> = (verdict.findings ?? []).map((f) => ({
    id: f.id,
    severity: f.severity,
    title: f.title,
    body: f.body,
    ...(f.fixHint !== null && f.fixHint !== undefined && { fixHint: f.fixHint }),
  }));
  const worst = maxSeverity(findings);
  // P2/P3-only or audited-clean ⇒ pass (the posture handles residual findings at merge).
  if (worst === undefined || worst === "P2" || worst === "P3") {
    return { kind: "pass" };
  }
  const blocking = findings.filter((f) => f.severity === worst);
  const reason =
    verdict.reasoning === "" ? blocking.map((f) => `${f.severity} ${f.title}`).join("; ") : verdict.reasoning;
  const outstandingBehaviorIds = blocking.map((f) => f.id);
  // A P0 finding is irrecoverable in this run ⇒ halt; a P1 is recoverable ⇒ loop back.
  return {
    kind: "reject",
    action: worst === "P0" ? "halt" : "loop_to_planner",
    reason,
    outstandingBehaviorIds,
  };
}
