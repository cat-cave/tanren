// P2A-0012: checker module for the planner-feedback loop. Builds the
// per-subtask check prompt against the typed CheckAnswer schema (P2A-0008)
// and exposes a `decideCheckerOutcome` helper the subtask loop uses to
// branch into the rejection-loop path.
import { answererOutputSchemaFor, CheckAnswer } from "../../answerers/schemas/index.js";
import type { PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";

export interface CheckerSubtaskContext {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  subtask: PlanSubtask;
  writerDiff: string;
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

export function buildCheckerPrompt(context: CheckerSubtaskContext): string {
  return [
    "You are the Tanren Checker Answerer. Your ONLY job is to judge intent",
    "satisfaction: does the writer diff fulfil the subtask intent and each",
    "explicit acceptance criterion in the spec? Judge by reading the diff and",
    "the spec — nothing else.",
    "",
    "Hard boundaries (a separate deterministic gate, not you, owns correctness):",
    "- Do NOT run, simulate, invoke, or shell out to tests, builds, type checks,",
    "  linters, or any command. The workspace may be unbuilt; that is expected",
    "  and is NOT your concern.",
    "- Do NOT assert, claim, predict, or report whether tests/build/lint pass or",
    "  fail. A separate in-loop deterministic gate verifies correctness; never",
    "  base your verdict on it or speculate about its result.",
    "- Do NOT edit files, run mutation commands, create commits, or write to the",
    "  workspace.",
    "- Judge intent only. 'The code looks like it might fail to compile/test' is",
    "  out of scope: if the intent and criteria are addressed by the diff, that",
    "  satisfies you.",
    "",
    "Return only the structured JSON required by the provided schema.",
    "",
    `Spec title: ${context.specTitle}`,
    `Spec description: ${context.specDescription}`,
    "Explicit acceptance criteria (judge each one):",
    ...context.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `Subtask [${context.subtask.index}]: ${context.subtask.title}`,
    `Subtask intent: ${context.subtask.intent}`,
    `Subtask behavior ids: ${context.subtask.behaviorIds.join(", ") || "(none)"}`,
    "",
    "In `reasoning`, cite each acceptance criterion / behavior by name and state",
    "whether the diff satisfies its intent and why. Set passed=true only when the",
    "subtask intent and every relevant acceptance criterion are satisfied by the",
    "diff. Always populate behaviorIdsPassed and behaviorIdsFailed (use empty",
    "arrays when none), reflecting intent satisfaction — not test/build outcomes.",
    "",
    "Writer diff:",
    context.writerDiff,
  ].join("\n");
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
