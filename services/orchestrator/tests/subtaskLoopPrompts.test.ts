// Mutation ratchet (run-loop cluster): subtaskLoop.ts builds the per-subtask
// writer prompt (writerPromptFor), and threads the run baseSha (not an injected
// diff) to the auditor — which now tells the Answerer to inspect the change
// itself in its read-only workspace. Both are observable through the fake
// adapters: the writer records its prompt, and the auditor's prompt carries the
// self-inspection instruction via buildAuditorPrompt. These tests drive the real
// loop and assert those rendered strings so the literals / fallbacks survive no
// mutation.
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
} from "./helpers/plannerLoopHelpers.js";

describe("subtask loop — writer prompt rendering (writerPromptFor)", () => {
  it("renders the subtask index/title, intent, behaviors, and spec into the writer prompt", async () => {
    const writer = makeWriter(["diff a\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "Wire helper", intent: "expose ok()", behaviorIds: ["B1", "B2"] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    expect(writer.calls).toHaveLength(1);
    const prompt = writer.calls[0]!.prompt;
    expect(prompt).toContain("Subtask [0]: Wire helper");
    expect(prompt).toContain("Intent: expose ok()");
    expect(prompt).toContain("Behaviors: B1, B2");
    // The spec title + description are appended.
    expect(prompt).toContain("Spec: Test spec");
    expect(prompt).toContain("exercise the spec loop");
  });

  it("threads the spec's acceptance criteria + the standing anti-stub toolchain instruction into the writer prompt", async () => {
    const writer = makeWriter(["diff a\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "Wire helper", intent: "expose ok()", behaviorIds: ["B1"] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    await runSubtaskLoop(input);

    const prompt = writer.calls[0]!.prompt;
    // The acceptance criteria (the same bar the checker judges) reach the writer.
    expect(prompt).toContain("Acceptance criteria:");
    expect(prompt).toContain("- README mentions ok");
    // The standing toolchain instruction steers the writer away from `workspace:*`
    // stub packages BEFORE it spends the iteration (the #273 scaffold failure mode).
    expect(prompt).toContain("NEVER create local");
    expect(prompt).toContain("workspace:*");
    expect(prompt).toContain("real published packages");
  });

  it("falls back to (none) in the writer prompt when the subtask has no behaviors", async () => {
    const writer = makeWriter(["diff a\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T", intent: "i", behaviorIds: [] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    await runSubtaskLoop(input);
    expect(writer.calls[0]!.prompt).toContain("Behaviors: (none)");
  });
});

describe("subtask loop — auditor self-inspects the change (no injected diff)", () => {
  it("tells the auditor to inspect the change against the run base instead of embedding a diff", async () => {
    const auditor = makeAuditor([cleanAudit]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([
          buildPlan([
            { title: "T1", intent: "a", behaviorIds: [] },
            { title: "T2", intent: "b", behaviorIds: [] },
          ]),
        ]),
        writer: makeWriter(["DIFF_ONE", "DIFF_TWO"]),
        checker: makeChecker([completeCheck, completeCheck]),
        auditor,
      },
      // The loop threads the run base sha to the auditor (self-inspection target).
      context: { ...defaultLoopInput().input.context, baseSha: "d".repeat(40) },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // The auditor prompt carries the self-inspection instruction + the base sha,
    // and embeds no writer-diff payload.
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("Inspect it yourself: run");
    expect(prompt).toContain(`git diff ${"d".repeat(40)} -- . ':(exclude)node_modules'`);
    expect(prompt).not.toContain("Combined writer diff:");
    expect(prompt).not.toContain("DIFF_ONE");
    expect(prompt).not.toContain("DIFF_TWO");
  });
});
