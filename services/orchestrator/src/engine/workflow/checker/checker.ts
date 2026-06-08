// checker module for the spec-implementation loop. Builds the
// per-subtask check prompt against the typed CheckAnswer schema
// and exposes a `decideCheckerOutcome` helper the subtask loop uses to
// branch into the rework path.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the checker is
// COMPLETENESS-FINDINGS-ONLY. There is NO binary `passed`. `decideCheckerOutcome`
// reads the emitted `findings` (all P0): NO findings ⇒ the task is complete; ANY
// finding ⇒ the task is incomplete and routes straight back to the writer. The
// checker answers strictly "is THIS task complete for what downstream tasks need".
import { answererOutputSchemaFor, CheckAnswer } from "../../answerers/schemas/index.js";
import type { CheckFinding, PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildCheckerPrompt as buildCheckerPromptText } from "../answererPrompts.js";

// The v3 CheckAnswer (completeness findings + reasoning) closing instruction. The
// shared body lives in answererPrompts.ts; only this schema-specific tail names the
// production checker's output fields.
const CHECKER_V3_OUTPUT_INSTRUCTIONS = [
  "Emit your answer as a `findings` list — one entry per concrete way THIS task is",
  "not yet complete for what DOWNSTREAM tasks build on. Every such finding is",
  "blocking (treated as P0): nothing about delivering a task another task depends on",
  "is deferrable. Give each a stable slug `id`, a short `title`, a `body` with enough",
  "context to act on, and the `behaviorId` it blocks (or null). Emit an EMPTY",
  "`findings` list when the task is complete for downstream needs — never invent a",
  "finding. In `reasoning`, cite each acceptance criterion / behavior the downstream",
  "depends on and state whether the change delivers it (mark any test/build/lint-",
  "outcome criterion as gate-owned, NOT a finding). Do NOT render a pass/fail",
  "judgment — the loop decides complete-vs-incomplete from your findings.",
];

export interface CheckerSubtaskContext {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  subtask: PlanSubtask;
  // The run base the writer's change is diffed against. The checker runs INSIDE
  // the writer's read-only workspace and inspects the change itself (rather than
  // having a potentially huge diff injected into the prompt).
  baselineSha: string;
}

export interface CheckerInvokeInput {
  context: CheckerSubtaskContext;
  timeoutMs: number;
  workspace?: string;
}

export interface CheckerInvocationResult {
  verdict: CheckAnswer;
  schemaId: string;
}

export async function invokeChecker(
  checker: AnswererAdapter<CheckAnswer>,
  input: CheckerInvokeInput,
): Promise<CheckerInvocationResult> {
  const outputSchema = answererOutputSchemaFor("check", CheckAnswer);
  const prompt = buildCheckerPrompt(input.context);
  const verdict = await checker.runAnswerer({
    prompt,
    timeoutMs: input.timeoutMs,
    workspace: input.workspace,
    outputSchema,
  });
  return { verdict, schemaId: outputSchema.name };
}

// Production checker prompt: the canonical shared body (answererPrompts.ts) with
// the per-subtask context mapped down to the common input and the v3-schema
// closing instruction supplied.
export function buildCheckerPrompt(context: CheckerSubtaskContext): string {
  return buildCheckerPromptText({
    specTitle: context.specTitle,
    specDescription: context.specDescription,
    acceptanceCriteria: context.acceptanceCriteria,
    baselineSha: context.baselineSha,
    subtask: {
      index: context.subtask.index,
      title: context.subtask.title,
      intent: context.subtask.intent,
      behaviorIds: context.subtask.behaviorIds,
    },
    outputInstructions: CHECKER_V3_OUTPUT_INSTRUCTIONS,
  });
}

// CheckerDecision encodes the post-check branch the subtask loop should
// take. The decision is "pure" — it does not append events or persist rows —
// so the loop can replay it deterministically in tests. `reject` carries the
// completeness findings so the writer rework feedback names the concrete gaps.
export type CheckerDecision =
  | { kind: "pass" }
  | { kind: "reject"; reason: string; behaviorIdsFailed: ReadonlyArray<string>; findings: ReadonlyArray<CheckFinding> };

/**
 * Decide complete-vs-incomplete from the checker's EMITTED completeness findings.
 * NO findings ⇒ the task is complete (`pass`). ANY finding ⇒ incomplete (`reject`):
 * the task routes straight back to the writer. The reject `reason` is built from the
 * finding titles; `behaviorIdsFailed` collects each finding's `behaviorId` (the
 * downstream-blocked behaviors). `findings` is a REQUIRED field — a parsed verdict
 * ALWAYS carries a real, explicitly-emitted array (an omitted one fails to parse).
 */
export function decideCheckerOutcome(verdict: CheckAnswer): CheckerDecision {
  if (verdict.findings.length === 0) {
    return { kind: "pass" };
  }
  const reason = verdict.reasoning === "" ? verdict.findings.map((f) => f.title).join("; ") : verdict.reasoning;
  const behaviorIdsFailed = verdict.findings
    .map((f) => f.behaviorId)
    .filter((id): id is string => id !== null && id !== undefined);
  return {
    kind: "reject",
    reason,
    behaviorIdsFailed,
    findings: verdict.findings,
  };
}
