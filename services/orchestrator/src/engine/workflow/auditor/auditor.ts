// auditor module for the spec-implementation loop. Runs the typed AuditAnswer
// schema after every subtask has passed its checker pass, and exposes a
// `auditorFindings` helper that returns the auditor's emitted FINDINGS as the
// frozen `Finding` currency.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the auditor is
// FINDINGS-ONLY. The agent emits `findings[]` (each with an EXPLICIT severity P0–P3)
// and renders NO verdict — there is no `passed`/`recommendedAction` to read. ALL
// routing is DETERMINISTIC and happens DOWNSTREAM of the auditor: the loop collects
// the spec-gate CI-as-P0 + auditor + demo findings, and if any exist routes them
// through TRIAGE (root-cause dedup → tasks-here / new specs) + CONVERGENCE. The
// auditor's only job is to surface defects with honest severities.
import { answererOutputSchemaFor, AuditAnswer } from "../../answerers/schemas/index.js";
import { normalizeFinding } from "../../answerers/schemas/index.js";
import type { PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { type Finding, maxSeverity } from "../../contracts/findings.js";
import { buildAuditorPrompt as buildAuditorPromptText } from "../answererPrompts.js";

// The findings-only closing instruction. The shared body lives in answererPrompts.ts;
// only this schema-specific tail names the auditor's findings currency. The auditor
// DECLARES each defect's severity directly and renders NO pass/fail judgment — the
// loop's triage/convergence + the project posture (not the model) decide what blocks.
const AUDITOR_FINDINGS_OUTPUT_INSTRUCTIONS = [
  "Emit your audit as a `findings` list — one entry per concrete defect you found,",
  "each with an EXPLICIT severity: P0 (irrecoverable blocker / data-loss /",
  "build-breaking), P1 (blocking defect that must be reworked), P2 (non-blocking",
  "quality gap worth fixing), P3 (minor polish). Give each a stable slug `id`, a short",
  "`title`, a `body` with enough context to act on, and an optional `fixHint`. Emit an",
  "EMPTY `findings` list when the change is audited-clean — never invent a finding. Do",
  "NOT render a pass/fail/halt judgment yourself: the loop's triage + the project's",
  "posture decide what a finding's severity means for the merge.",
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
    workspace: input.workspace,
    outputSchema,
  });
  return { verdict, schemaId: outputSchema.name };
}

// Production auditor prompt: the canonical shared body (answererPrompts.ts) with
// the executed-subtasks context mapped down to the common input and the findings-only
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

/**
 * The auditor's emitted findings as the frozen stored `Finding` currency. PURE — so
 * the loop's routing (triage/convergence/posture) is tested deterministically without
 * re-running the CLI. `findings` is a REQUIRED field on the parsed `AuditAnswer` (no
 * `.default([])`): a parsed verdict ALWAYS carries a real, explicitly-emitted array,
 * so a clean `[]` is reachable ONLY from an explicit empty list (an omitted one fails
 * to parse upstream). `normalizeFinding` collapses a strict-schema `fixHint: null` to
 * an absent key so the stored shape matches `{ fixHint?: string }`.
 */
export function auditorFindings(verdict: AuditAnswer): Finding[] {
  return verdict.findings.map((f) => normalizeFinding(f));
}

/**
 * A simple findings → block-or-clean decision for callers (e.g. the conflict
 * resolved-tree re-gate) that need a single yes/no GATE on the auditor's output
 * WITHOUT the full triage/convergence loop. A P0 OR P1 finding BLOCKS; P2/P3-only or
 * audited-clean does NOT. `reason` names the blocking findings (severity + title) so
 * the gate failure is legible. This is the same default-posture threshold (`P1`) the
 * loop's triage routes P0/P1 to tasks at; the residual P2/P3 is the posture's job at
 * merge, never a re-gate block.
 */
export function auditorReGateDecision(verdict: AuditAnswer): { blocked: boolean; reason: string } {
  const findings = auditorFindings(verdict);
  const worst = maxSeverity(findings);
  if (worst === undefined || worst === "P2" || worst === "P3") {
    return { blocked: false, reason: "auditor found no blocking (P0/P1) findings" };
  }
  const blocking = findings.filter((f) => f.severity === "P0" || f.severity === "P1");
  return { blocked: true, reason: blocking.map((f) => `${f.severity} ${f.title}`).join("; ") };
}
