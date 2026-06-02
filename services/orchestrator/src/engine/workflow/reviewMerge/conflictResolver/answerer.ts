// The conflict-resolution Answerer invoker (autonomy-engine.md §2b step 3;
// PROJECT_BRIEF §2.2). Wraps the routing-resolved conflict Answerer adapter +
// builds the prompt that hands the model BOTH conflicting specs' intent +
// acceptance criteria, the conflict hunks, and the DAG edge — then returns the
// schema-validated ConflictAnswer.
//
// Writer/Answerer boundary (PROJECT_BRIEF §3): this is an ANSWERER. It is
// read-only — it never edits files, runs commands, or merges. It only judges the
// conflict and returns the structured resolution plan; the
// WorkspaceConflictApplier (the writer-adjacent step) owns applying the tree over
// the runner, and the re-gate owns verifying it. The Answerer contract's schema
// validation rejects a non-conforming model output (the same gate the
// planner/checker/auditor/reviewer Answerers use).

import { answererOutputSchemaFor, ConflictAnswer } from "../../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import type { ConflictAnswererInvoker, ConflictedFile, SpecIntent } from "../../../contracts/conflictResolution.js";

export interface AnswererBackedConflictInvokerDeps {
  adapter: AnswererAdapter<ConflictAnswer>;
  timeoutMs: number;
  workspace?: string;
}

export class AnswererBackedConflictInvoker implements ConflictAnswererInvoker {
  constructor(private readonly deps: AnswererBackedConflictInvokerDeps) {}

  async resolve(input: {
    mergingSpecIntent: SpecIntent;
    conflictingSpecIntent?: SpecIntent;
    dagEdge: boolean;
    conflictedFiles: ReadonlyArray<ConflictedFile>;
  }): Promise<ConflictAnswer> {
    const outputSchema = answererOutputSchemaFor("conflict", ConflictAnswer);
    const prompt = buildConflictResolverPrompt(input);
    const answerOpts: Parameters<typeof this.deps.adapter.runAnswerer>[0] = {
      prompt,
      timeoutMs: this.deps.timeoutMs,
      outputSchema,
      ...(this.deps.workspace !== undefined && { workspace: this.deps.workspace }),
    };
    return this.deps.adapter.runAnswerer(answerOpts);
  }
}

export function buildConflictResolverPrompt(input: {
  mergingSpecIntent: SpecIntent;
  conflictingSpecIntent?: SpecIntent;
  dagEdge: boolean;
  conflictedFiles: ReadonlyArray<ConflictedFile>;
}): string {
  const lines: string[] = [
    "You are the Tanren Conflict-Resolution-Planner Answerer. A merge conflict",
    "arose between TWO specs' changes. A conflict is a RE-PLANNING problem, not a",
    "text-picking problem: you have BOTH specs' intent + acceptance criteria, so",
    "resolve to satisfy BOTH intents — never pick one side's text and drop the",
    "other's intent.",
    "",
    "Hard boundaries (you are an Answerer — read-only):",
    "- Do NOT run, simulate, or shell out to tests/builds/linters. A separate",
    "  deterministic gate (run AFTER you) verifies the resolved tree.",
    "- Do NOT edit files or create commits. You return a structured PLAN only; the",
    "  orchestrator applies it and re-gates.",
    "",
    "Decide ONE of:",
    "- decision='resolve': return `resolvedFiles` with the FULL resolved content",
    "  (conflict markers removed) for EVERY conflicted file, preserving BOTH",
    "  intents. Leave `replanSpec` null.",
    "- decision='irreconcilable': the two intents CANNOT both be satisfied by one",
    "  edit. Return `replanSpec` naming which spec to re-plan ('merging' = the spec",
    "  whose PR is merging; 'base' = the spec already merged on the base branch)",
    "  and `newContext` = the OTHER spec's change as planning context, so the",
    "  re-planned spec satisfies its intent ON TOP of the other's. Leave",
    "  `resolvedFiles` empty. (Intent stays alive; nothing is dropped or merged.)",
    "",
    `DAG edge between the two specs: ${input.dagEdge ? "YES (a known dependency relationship)" : "NO (no persisted dependency edge)"}`,
    "",
    "=== MERGING spec (the PR being merged) ===",
    ...specIntentLines(input.mergingSpecIntent),
    "",
    "=== BASE spec (the change already on the base branch) ===",
    ...baseSpecLines(input.conflictingSpecIntent),
    "",
    "=== Conflicted files (markers intact) ===",
    ...input.conflictedFiles.flatMap((file) => [`--- ${file.path} ---`, file.conflictedContent]),
    "",
    "Return only the structured JSON required by the provided schema.",
  ];
  return lines.join("\n");
}

function baseSpecLines(conflictingSpecIntent: SpecIntent | undefined): string[] {
  if (conflictingSpecIntent === undefined) {
    return [
      "(No other spec could be attributed to the conflicting change. Resolve to",
      "preserve the MERGING spec's intent on top of the base-branch change, or",
      "route the merging spec back to the planner if that is impossible.)",
    ];
  }
  return specIntentLines(conflictingSpecIntent);
}

function specIntentLines(intent: SpecIntent): string[] {
  return [
    `Spec id: ${intent.specId}`,
    `Title: ${intent.title}`,
    `Description: ${intent.description}`,
    "Acceptance criteria:",
    ...intent.acceptanceCriteria.map((c) => `- ${c}`),
  ];
}
