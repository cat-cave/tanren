// real planner module. Builds the Codex-targeted prompt that emits
// a typed `PlanAnswer` and dispatches it through an injected
// Answerer adapter. The Answerer abstraction lets unit tests drive the loop
// without an SSH-backed Codex CLI; the production wiring uses the Codex
// adapter (see services/orchestrator/src/engine/providers/codex.ts).
import { answererOutputSchemaFor, PlanAnswer, type PlanSubtask } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";

// Compact spec context the planner consumes. Behaviors are passed in
// pre-resolved (entity lookups happen at workflow construction
// time so the planner module stays free of repository access).
export interface PlannerSpecContext {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  // Behavior ids the planner may reference. v0 keeps them opaque strings;
  // entity title/given/when/then text is rendered upstream into the
  // `behaviorContext` field below.
  behaviorIds: ReadonlyArray<string>;
  behaviorContext: ReadonlyArray<{ id: string; title: string; description: string }>;
}

// A single rejection feedback record handed to the planner on re-invocation.
// Carrying both the producer and the structured reason matters because the
// auditor and the checker reject for very different reasons (a checker
// rejects per-subtask criteria; the auditor rejects the integrated result;
// the deterministic gate rejects on a nonzero build/test/lint exit).
export interface PlannerRejectionFeedback {
  // adds "reviewer": a changes-requested PR review routed back through
  // the same rework path the checker/auditor/gate use, so the planner re-plans
  // against the reviewer's feedback. "writer" is a hard writer failure (the
  // provider crashed / timed out mid-subtask) routed through the SAME path so a
  // non-completing writer re-plans instead of being laundered into a passed task.
  producer: "checker" | "auditor" | "gate" | "reviewer" | "writer";
  rejectionReason: string;
  behaviorIdsFailed: ReadonlyArray<string>;
  previousSubtasks: ReadonlyArray<PlanSubtask>;
}

export interface PlannerInvokeInput {
  spec: PlannerSpecContext;
  // Empty on the first plan, populated on re-runs. The planner is expected
  // to inspect every prior rejection so the new decomposition addresses the
  // outstanding behavior ids.
  rejectionHistory: ReadonlyArray<PlannerRejectionFeedback>;
  // Workspace path passed through to the Answerer adapter. Codex needs a
  // workspace mount even for read-only answerer calls.
  workspace?: string;
}

export interface PlannerInvocationResult {
  plan: PlanAnswer;
  // The raw schema name the Codex CLI was invoked with — surfaced so the
  // workflow can record it on the planner task row for traceability.
  schemaId: string;
}

// invokePlanner runs the configured Answerer adapter against the canonical
// PlanAnswer schema. It does not own task persistence or cost recording;
// callers handle those (see subtaskLoop.ts) so the same module works for
// both the real workflow and the unit tests.
export async function invokePlanner(
  planner: AnswererAdapter<PlanAnswer>,
  input: PlannerInvokeInput,
): Promise<PlannerInvocationResult> {
  const outputSchema = answererOutputSchemaFor("plan", PlanAnswer);
  const prompt = buildPlannerPrompt(input);
  const plan = await planner.runAnswerer({
    prompt,
    workspace: input.workspace,
    outputSchema,
  });
  return { plan, schemaId: outputSchema.name };
}

// buildPlannerPrompt is exported for the prompt-shape test. It is the only
// place that knows what context layers the v0 planner receives. Future
// changes (e.g. resource budgets, prior diffs) feed in here.
export function buildPlannerPrompt(input: PlannerInvokeInput): string {
  const header = [
    "You are the Tanren Planner Answerer. Decompose the spec into ordered subtasks.",
    "Return only the structured JSON required by the provided schema.",
    "Do not edit files, run mutation commands, create commits, or write to the workspace.",
    "",
    `Spec title: ${input.spec.specTitle}`,
    `Spec description: ${input.spec.specDescription}`,
    "Acceptance criteria:",
    ...input.spec.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
  ];
  const behaviors =
    input.spec.behaviorContext.length === 0
      ? ["Behaviors: none declared.", ""]
      : [
          "Declared behaviors (refer to these by id in subtasks.behaviorIds):",
          ...input.spec.behaviorContext.map((entry) => `- ${entry.id}: ${entry.title} — ${entry.description}`),
          "",
        ];
  const rejectionBlocks = renderRejectionHistory(input.rejectionHistory);
  // Grading-criteria awareness (spec-loop redesign §PLANNER): the subtasks you emit
  // are graded against the SAME bars the spec is. Write each task description so it
  // is gradable against all of them — so the writer aims at the gate, not at a guess.
  const gradingCriteria = [
    "How the resulting work is graded — write each subtask so it is GRADABLE against",
    "these bars (a task that cannot be checked/audited/demonstrated will loop back):",
    "- DETERMINISTIC GATE (fmt/lint/typecheck, then tests/build): each subtask's",
    "  change must keep the project building and its checks green. Do NOT plan work",
    "  that leaves the tree un-buildable for a later subtask to fix.",
    "- CHECKER (completeness): each subtask must be COMPLETE for what later subtasks",
    "  depend on — state, in the intent, the observable outcome that proves it done.",
    "- AUDITOR (quality/security/perf/scalability): plan for correct, secure,",
    "  reasonably-performant changes — not just ones that compile.",
    "- DEMO: the spec has a concrete 'show me it works'; ensure the subtasks together",
    "  produce that observable behavior so the demo can exercise it.",
    "",
  ];
  const footer = [
    "Every subtask MUST be an actionable change that modifies the workspace and",
    "produces a git diff advancing the acceptance criteria. Do NOT emit read-only",
    "or inspection-only subtasks (e.g. 'inspect', 'investigate', 'understand',",
    "'review the contract', 'confirm the location'): the Writer reads the",
    "repository as needed before it implements, and a subtask whose intent is only",
    "to read will be rejected because its diff cannot satisfy that intent. Emit the",
    "fewest subtasks that fully implement the spec — frequently exactly one.",
    "",
    "Emit at least one subtask. Each subtask must declare:",
    "- index: 0-based position in the execution order",
    "- title: short human-readable label",
    "- intent: declared rationale for this subtask (an action that changes code)",
    "- behaviorIds: subset of declared behavior ids this subtask satisfies",
    "- estimatedTokens: integer estimate or null when unknown",
    "Provide a top-level rationale explaining the decomposition.",
  ];
  return [...header, ...behaviors, ...gradingCriteria, ...rejectionBlocks, ...footer].join("\n");
}

function renderRejectionHistory(history: ReadonlyArray<PlannerRejectionFeedback>): string[] {
  if (history.length === 0) {
    return ["This is the first plan for the spec — no prior rejections.", ""];
  }
  const lines = ["Prior rejections — address every outstanding behavior id in the new plan:", ""];
  for (const [index, entry] of history.entries()) {
    lines.push(`Rejection #${index + 1} from ${entry.producer}:`);
    lines.push(`  reason: ${entry.rejectionReason}`);
    lines.push(`  behaviorIdsFailed: ${entry.behaviorIdsFailed.join(", ") || "(none reported)"}`);
    lines.push(`  prior subtasks:`);
    for (const subtask of entry.previousSubtasks) {
      lines.push(`    [${subtask.index}] ${subtask.title} — ${subtask.intent}`);
    }
    lines.push("");
  }
  return lines;
}
