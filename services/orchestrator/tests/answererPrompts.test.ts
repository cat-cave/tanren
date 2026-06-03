// Single home for the SHARED checker/auditor prompt-body contract. Both answerer
// paths (the production run path via checker.ts/auditor.ts and the structured-task
// path via answererTasks.ts) route through these unified builders, so the canonical
// text — role framing, the self-inspection `git diff` block, the hard boundaries,
// and the spec/criteria rendering — is asserted ONCE here. The production wrappers'
// rendered contract (with the v2 closing instructions + the subtask block) lives in
// runloopPrompts.test.ts; the structured-task wiring (v1 closing) in
// answererTasks.test.ts.
import { describe, expect, it } from "vitest";
import { buildAuditorPrompt, buildCheckerPrompt } from "../src/engine/workflow/answererPrompts.js";

const baselineSha = "a".repeat(40);

describe("buildCheckerPrompt — shared body", () => {
  it("renders the canonical role framing + self-inspection block (never injects a diff)", () => {
    const prompt = buildCheckerPrompt({
      specTitle: "Spec X",
      specDescription: "Do the thing.",
      acceptanceCriteria: ["AC1: file exists"],
      baselineSha,
      outputInstructions: ["CLOSING-CHECK"],
    });
    expect(prompt).toContain("You are the Tanren Checker Answerer. Your ONLY job is to judge intent");
    // Self-inspection — the verified behaviour: the agent diffs the change itself.
    expect(prompt).toContain("Inspect it yourself: run");
    expect(prompt).toContain(`  git diff ${baselineSha} -- . ':(exclude)node_modules'`);
    expect(prompt).toContain("Do NOT expect the diff");
    expect(prompt).not.toContain("diff --git");
    // Read-only / structured-output boundaries intact.
    expect(prompt).toContain("Do NOT run, simulate, invoke, or shell out to tests");
    expect(prompt).toContain("Do NOT edit files, run mutation commands, create commits, or write to the");
    expect(prompt).toContain("Return only the structured JSON required by the provided schema.");
    // Spec + criteria + the caller-supplied closing instruction.
    expect(prompt).toContain("Spec title: Spec X");
    expect(prompt).toContain("- AC1: file exists");
    expect(prompt.trimEnd().endsWith("CLOSING-CHECK")).toBe(true);
  });

  it("includes the subtask block only when a subtask is supplied (production), omits it otherwise (structured)", () => {
    const withSubtask = buildCheckerPrompt({
      specTitle: "S",
      specDescription: "D",
      acceptanceCriteria: ["AC1"],
      baselineSha,
      subtask: { index: 2, title: "T", intent: "wire it", behaviorIds: ["B1", "B2"] },
      outputInstructions: ["X"],
    });
    expect(withSubtask).toContain("Subtask [2]: T");
    expect(withSubtask).toContain("Subtask intent: wire it");
    expect(withSubtask).toContain("Subtask behavior ids: B1, B2");

    const noSubtask = buildCheckerPrompt({
      specTitle: "S",
      specDescription: "D",
      acceptanceCriteria: ["AC1"],
      baselineSha,
      outputInstructions: ["X"],
    });
    expect(noSubtask).not.toContain("Subtask [");
    expect(noSubtask).not.toContain("Subtask intent:");
  });

  it("falls back to (none) for an empty subtask behavior id list", () => {
    const prompt = buildCheckerPrompt({
      specTitle: "S",
      specDescription: "D",
      acceptanceCriteria: ["AC1"],
      baselineSha,
      subtask: { index: 0, title: "T", intent: "i", behaviorIds: [] },
      outputInstructions: ["X"],
    });
    expect(prompt).toContain("Subtask behavior ids: (none)");
  });
});

describe("buildAuditorPrompt — shared body", () => {
  it("renders the canonical role framing + self-inspection block (never injects a diff)", () => {
    const prompt = buildAuditorPrompt({
      specTitle: "Spec Y",
      acceptanceCriteria: ["AC1: all helpers exist"],
      baselineSha,
      outputInstructions: ["CLOSING-AUDIT"],
    });
    expect(prompt).toContain(
      "You are the Tanren Auditor Answerer. Audit whether the executed subtask plan satisfies the spec.",
    );
    expect(prompt).toContain("Inspect it yourself: run");
    expect(prompt).toContain(`  git diff ${baselineSha} -- . ':(exclude)node_modules'`);
    expect(prompt).toContain("Do NOT expect the diff");
    expect(prompt).not.toContain("diff --git");
    expect(prompt).toContain("Do not edit files, run mutation commands, create commits, or write to the workspace.");
    expect(prompt).toContain("Spec title: Spec Y");
    expect(prompt).toContain("- AC1: all helpers exist");
    expect(prompt.trimEnd().endsWith("CLOSING-AUDIT")).toBe(true);
  });

  it("includes the executed-subtasks block (production) and the checker-answer block (structured) only when supplied", () => {
    const withSubtasks = buildAuditorPrompt({
      specTitle: "S",
      specDescription: "D",
      acceptanceCriteria: ["AC1"],
      baselineSha,
      subtasks: [
        { index: 0, title: "S0", intent: "i0", behaviorIds: ["B1"] },
        { index: 1, title: "S1", intent: "i1", behaviorIds: [] },
      ],
      outputInstructions: ["X"],
    });
    expect(withSubtasks).toContain("Executed subtasks:");
    expect(withSubtasks).toContain("- [0] S0 (intent: i0, behaviors: B1)");
    expect(withSubtasks).toContain("- [1] S1 (intent: i1, behaviors: (none))");
    expect(withSubtasks).toContain("Spec description: D");
    expect(withSubtasks).not.toContain("Checker answer:");

    const withCheckAnswer = buildAuditorPrompt({
      specTitle: "S",
      acceptanceCriteria: ["AC1"],
      baselineSha,
      checkAnswer: { done: true, reason: "ok" },
      outputInstructions: ["X"],
    });
    expect(withCheckAnswer).toContain("Checker answer:");
    expect(withCheckAnswer).toContain('"done": true');
    expect(withCheckAnswer).not.toContain("Executed subtasks:");
    // specDescription omitted (structured path) → no Spec description line.
    expect(withCheckAnswer).not.toContain("Spec description:");
  });
});
