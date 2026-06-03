// Mutation ratchet (run-loop cluster): subtaskLoop.ts builds two internal
// strings whose content was never asserted — the per-subtask writer prompt
// (writerPromptFor) and the auditor's combined diff (combineDiffs, which drops
// empty diffs and newline-joins the rest). Both are observable through the fake
// adapters: the writer records its prompt, and the auditor's prompt embeds the
// combined diff via buildAuditorPrompt. These tests drive the real loop and
// assert those rendered strings so the literals / fallbacks / filter survive no
// mutation.
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  buildPlan,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";

describe("subtask loop — writer prompt rendering (writerPromptFor)", () => {
  it("renders the subtask index/title, intent, behaviors, and spec into the writer prompt", async () => {
    const writer = makeWriter(["diff a\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        planner: makePlanner([buildPlan([{ title: "Wire helper", intent: "expose ok()", behaviorIds: ["B1", "B2"] }])]),
        writer,
        checker: makeChecker([passingCheck]),
        auditor: makeAuditor([passingAudit]),
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
    expect(prompt).toContain("exercise the planner loop");
  });

  it("threads the spec's acceptance criteria + the standing anti-stub toolchain instruction into the writer prompt", async () => {
    const writer = makeWriter(["diff a\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        planner: makePlanner([buildPlan([{ title: "Wire helper", intent: "expose ok()", behaviorIds: ["B1"] }])]),
        writer,
        checker: makeChecker([passingCheck]),
        auditor: makeAuditor([passingAudit]),
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
        planner: makePlanner([buildPlan([{ title: "T", intent: "i", behaviorIds: [] }])]),
        writer,
        checker: makeChecker([passingCheck]),
        auditor: makeAuditor([passingAudit]),
      },
    });
    await runSubtaskLoop(input);
    expect(writer.calls[0]!.prompt).toContain("Behaviors: (none)");
  });
});

describe("subtask loop — combined diff handed to the auditor (combineDiffs)", () => {
  it("newline-joins every non-empty writer diff in subtask order", async () => {
    const auditor = makeAuditor([passingAudit]);
    const { input } = defaultLoopInput({
      adapters: {
        planner: makePlanner([
          buildPlan([
            { title: "T1", intent: "a", behaviorIds: [] },
            { title: "T2", intent: "b", behaviorIds: [] },
          ]),
        ]),
        writer: makeWriter(["DIFF_ONE", "DIFF_TWO"]),
        checker: makeChecker([passingCheck, passingCheck]),
        auditor,
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // The auditor prompt embeds the combined diff after the "Combined writer
    // diff:" header — both writer diffs, newline-joined, in order.
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("Combined writer diff:");
    expect(prompt).toContain("DIFF_ONE\nDIFF_TWO");
  });

  it("drops empty writer diffs from the combined diff", async () => {
    const auditor = makeAuditor([passingAudit]);
    const { input } = defaultLoopInput({
      adapters: {
        planner: makePlanner([
          buildPlan([
            { title: "T1", intent: "a", behaviorIds: [] },
            { title: "T2", intent: "b", behaviorIds: [] },
          ]),
        ]),
        // First subtask produces no diff (empty string) — it must be filtered
        // out so the combined diff is just the second, non-empty diff.
        writer: makeWriter(["", "ONLY_REAL_DIFF"]),
        checker: makeChecker([passingCheck, passingCheck]),
        auditor,
      },
    });
    await runSubtaskLoop(input);

    const prompt = auditor.calls[0]!.prompt;
    // The non-empty diff is present; no leading blank-line join artefact.
    expect(prompt).toContain("Combined writer diff:\nONLY_REAL_DIFF");
  });
});
