// P2A-0012: auditor module for the planner-feedback loop. Runs the typed
// AuditAnswer schema (P2A-0008) after every subtask has passed its checker
// pass, and exposes a `decideAuditorOutcome` helper that maps the
// `recommendedAction` into the rejection-loop branch the subtask loop takes.
import { answererOutputSchemaFor, AuditAnswer, type AuditRecommendedAction } from "../../answerers/schemas/index.js";
import type { PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";

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

export function buildAuditorPrompt(context: AuditorSpecContext): string {
  return [
    "You are the Tanren Auditor Answerer. Audit whether the executed subtask plan satisfies the spec.",
    "Return only the structured JSON required by the provided schema.",
    "Do not edit files, run mutation commands, create commits, or write to the workspace.",
    "",
    "The combined writer change is committed on the current branch of your read-only",
    "workspace. Inspect it yourself: run",
    `  git diff ${context.baselineSha} -- . ':(exclude)node_modules'`,
    "to see the change, then read the changed source files, and judge against the spec.",
    "",
    `Spec title: ${context.specTitle}`,
    `Spec description: ${context.specDescription}`,
    "Acceptance criteria:",
    ...context.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Executed subtasks:",
    ...context.subtasks.map(
      (subtask) =>
        `- [${subtask.index}] ${subtask.title} (intent: ${subtask.intent}, behaviors: ${subtask.behaviorIds.join(", ") || "(none)"})`,
    ),
    "",
    "Set passed=true only when every acceptance criterion is satisfied by the combined writer change.",
    "Set recommendedAction='pass' when passed=true.",
    "Set recommendedAction='loop_to_planner' when the spec is recoverable by re-planning.",
    "Set recommendedAction='halt' when the spec is not recoverable in this run.",
  ].join("\n");
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
