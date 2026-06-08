// auditor module for the planner-feedback loop. Runs the typed
// AuditAnswer schema after every subtask has passed its checker
// pass, and exposes a `decideAuditorOutcome` helper that maps the
// `recommendedAction` into the rejection-loop branch the subtask loop takes.
import { answererOutputSchemaFor, AuditAnswer, type AuditRecommendedAction } from "../../answerers/schemas/index.js";
import type { PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildAuditorPrompt as buildAuditorPromptText } from "../answererPrompts.js";

// The v2 AuditAnswer (passed / reasoning / outstandingBehaviorIds /
// recommendedAction) closing instruction. The shared body lives in
// answererPrompts.ts; only this schema-specific tail names the auditor's fields.
const AUDITOR_V2_OUTPUT_INSTRUCTIONS = [
  "Set passed=true only when every acceptance criterion is satisfied by the combined writer change.",
  "Set recommendedAction='pass' when passed=true.",
  "Set recommendedAction='loop_to_planner' when the spec is recoverable by re-planning.",
  "Set recommendedAction='halt' when the spec is not recoverable in this run.",
  // WAVE-2 / SLICE P-A: emit EXPLICIT findings — the new severity currency. You
  // render NO pass/fail judgment from severity; you DECLARE each defect's severity
  // directly. The project's posture (not you) decides what blocks.
  "Populate `findings` with one entry per concrete defect you found, each with an",
  "EXPLICIT severity: P0 (irrecoverable blocker / data-loss / build-breaking),",
  "P1 (blocking defect that must be reworked), P2 (non-blocking quality gap worth",
  "fixing), P3 (minor polish). Give each a stable slug `id`, a short `title`, a",
  "`body` with enough context to act on, and an optional `fixHint`. Emit an EMPTY",
  "`findings` list when the change is audited-clean — never invent a finding.",
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
    outputInstructions: AUDITOR_V2_OUTPUT_INSTRUCTIONS,
  });
}

// AuditorDecision encodes the rejection-loop branch. As with the checker,
// the decision is pure so the subtask loop's branching can be tested
// deterministically without re-running the Codex CLI.
export type AuditorDecision =
  | { kind: "pass" }
  | {
      kind: "reject";
      action: Extract<AuditRecommendedAction, "loop_to_planner" | "halt">;
      reason: string;
      outstandingBehaviorIds: ReadonlyArray<string>;
    };

export function decideAuditorOutcome(verdict: AuditAnswer): AuditorDecision {
  if (verdict.passed) {
    return { kind: "pass" };
  }
  if (verdict.recommendedAction === "halt") {
    return {
      kind: "reject",
      action: "halt",
      reason: verdict.reasoning,
      outstandingBehaviorIds: verdict.outstandingBehaviorIds,
    };
  }
  // The auditor schema enum admits "pass" | "loop_to_planner" | "halt"; the
  // pass branch is handled above, so any non-halt failure routes to the
  // planner. This includes a defensive treatment of "pass" + passed=false
  // (which would itself be a schema violation upstream) as a loop-to-planner
  // signal so the run does not silently terminate.
  return {
    kind: "reject",
    action: "loop_to_planner",
    reason: verdict.reasoning,
    outstandingBehaviorIds: verdict.outstandingBehaviorIds,
  };
}
