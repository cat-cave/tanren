// checker module for the planner-feedback loop. Builds the
// per-subtask check prompt against the typed CheckAnswer schema
// and exposes a `decideCheckerOutcome` helper the subtask loop uses to
// branch into the rejection-loop path.
import { answererOutputSchemaFor, CheckAnswer } from "../../answerers/schemas/index.js";
import type { PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildCheckerPrompt as buildCheckerPromptText } from "../answererPrompts.js";

// The v2 CheckAnswer (passed / reasoning / behaviorIds*) closing instruction.
// The shared body lives in answererPrompts.ts; only this schema-specific tail
// names the production checker's output fields.
const CHECKER_V2_OUTPUT_INSTRUCTIONS = [
  "In `reasoning`, cite each acceptance criterion / behavior by name and state",
  "whether the change satisfies its intent and why (marking any test/build/lint-",
  "outcome criterion as gate-deferred). Set passed=true when the subtask intent",
  "and every diff-assessable acceptance criterion are satisfied by the change;",
  "gate-deferred outcome criteria must not block a pass. Always populate",
  "behaviorIdsPassed and behaviorIdsFailed (use empty arrays when none),",
  "reflecting intent satisfaction — not test/build outcomes.",
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
// the per-subtask context mapped down to the common input and the v2-schema
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
    outputInstructions: CHECKER_V2_OUTPUT_INSTRUCTIONS,
  });
}

// CheckerDecision encodes the post-check branch the subtask loop should
// take. The decision is "pure" — it does not append events or persist rows —
// so the loop can replay it deterministically in tests.
export type CheckerDecision =
  | { kind: "pass" }
  | { kind: "reject"; reason: string; behaviorIdsFailed: ReadonlyArray<string> };

export function decideCheckerOutcome(verdict: CheckAnswer): CheckerDecision {
  if (verdict.passed) {
    return { kind: "pass" };
  }
  return {
    kind: "reject",
    reason: verdict.reasoning,
    behaviorIdsFailed: verdict.behaviorIdsFailed,
  };
}
