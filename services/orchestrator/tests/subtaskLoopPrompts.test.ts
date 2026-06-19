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
  incompleteCheck,
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
    // The standing toolchain instruction steers the writer to use the project's OWN
    // declared toolchain + real published deps and never stub/fake a binary BEFORE it
    // spends the iteration (the #273 scaffold failure mode) — STACK-AGNOSTIC: it names
    // no specific tool (no typescript/eslint/vitest/`workspace:*`), so it does not
    // misdirect a Rust/Python/novel-translation project.
    expect(prompt).toContain("project's OWN declared dependencies and toolchain");
    expect(prompt).toContain("NEVER stub, fake, vendor, or shim");
    expect(prompt).toContain("real published");
    expect(prompt).not.toContain("workspace:*");
    expect(prompt).not.toContain("typescript/eslint/vitest");
    expect(prompt).not.toContain("eslint");
    expect(prompt).not.toContain("vitest");
    // Spec-loop redesign §WRITER: the writer is told HOW it is graded — run the
    // fast deterministic gate before finishing, then the checker + auditor.
    expect(prompt).toContain("How your change will be graded");
    expect(prompt).toContain("FAST deterministic gate");
    expect(prompt).toContain("RUN it");
    // apex-v36: a FORMATTING failure is mechanical — the writer is steered to run the
    // project's DECLARED format-WRITE step (not just the check) and never hand back the
    // same unformatted output. Stack-agnostic: no baked-in tool name.
    expect(prompt).toContain("FORMATTING failure is mechanical");
    expect(prompt).toContain("format-WRITE step");
    expect(prompt).toContain("never hand back the same");
    expect(prompt).not.toContain("prettier");
    // apex-v43: the DERIVED-ARTIFACT reconciliation principle — a manifest edit without its
    // matching regenerated lockfile is rejected by a frozen-lockfile gate. The instruction
    // is framed around the project's DECLARED install/bootstrap step, stack-agnostic (no
    // pnpm/npm/cargo/pip literals). Also steers away from range-syntax churn being
    // mislabeled as an "upgrade".
    expect(prompt).toContain("RECONCILE generated companions");
    expect(prompt).toContain("generated or derived companion");
    expect(prompt).toContain("project's DECLARED command that regenerates");
    expect(prompt).toContain("frozen-lockfile gate");
    expect(prompt).toContain("project's declared install or bootstrap step");
    expect(prompt).toContain("bump to newer PUBLISHED versions");
    expect(prompt).toContain("rewriting version-range syntax");
    expect(prompt).toContain("NOT an upgrade");
    // Stack-agnostic: no package-manager names baked in.
    expect(prompt).not.toContain("pnpm");
    expect(prompt).not.toContain("npm");
    expect(prompt).not.toContain("cargo");
    expect(prompt).not.toContain("pip");
  });

  // v40 scaffold finding: the project's DECLARED CONTRACT files (the `justfile` lifecycle +
  // `.tanren/ci.yml` gate) are IMMUTABLE — the writer scaffolds the rest of the tree to SATISFY
  // the declared lifecycle commands WITHOUT editing them. The standing instruction names that
  // contract-file set up front (stack-agnostic — it is Tanren's OWN contract surface, not a
  // baked-in stack tool) so the writer never reaches for them.
  it("threads the IMMUTABLE-CONTRACT instruction (justfile + .tanren/ci.yml are fixed) into the writer prompt", async () => {
    const writer = makeWriter(["diff a\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "Scaffold", intent: "make the lifecycle pass", behaviorIds: [] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    await runSubtaskLoop(input);
    const prompt = writer.calls[0]!.prompt;
    expect(prompt).toContain("DECLARED CONTRACT files are FIXED");
    expect(prompt).toContain("justfile");
    expect(prompt).toContain(".tanren/ci.yml");
    expect(prompt).toContain("the contract your work SATISFIES, not changes");
    expect(prompt).toContain("NEVER change the contract file to match your");
  });

  // v40 scaffold finding (the PRECISE rework steering): when a rejection is a CONTRACT-FILE
  // violation (the writer edited the justfile / .tanren/ci.yml), the rework steering must be
  // precise — revert ONLY the change to the contract file, KEEP the rest of the scaffold — so
  // the writer stops oscillating between violate-everything and revert-the-whole-scaffold
  // (no net change), which is itself rejected. Here the checker rejects iteration 1 with a
  // contract-violation reasoning, then passes once the writer reworks; the iteration-2 prompt
  // must carry the precise steering.
  it("steers a CONTRACT-FILE violation to revert-only-the-contract-change + keep the scaffold (no oscillation)", async () => {
    const writer = makeWriter(["diff a\n", "diff b\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "Scaffold", intent: "make the lifecycle pass", behaviorIds: [] }])]),
        writer,
        // Iteration 1: reject with a CONTRACT-FILE violation (names the justfile). Iteration 2:
        // pass (the writer reverted only the contract change + kept the scaffold) — converges.
        checker: makeChecker([
          {
            findings: [
              {
                id: "contract-justfile-redefined",
                title: "the writer redefined the justfile (a fixed contract file)",
                body: "leave the justfile unchanged",
                behaviorId: "B1",
              },
            ],
            reasoning: "you redefined the justfile — a FIXED contract file you must not edit",
          },
          completeCheck,
        ]),
        auditor: makeAuditor([cleanAudit, cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // The writer re-iterated once (the loop converged on the rework, not an oscillation).
    expect(writer.calls).toHaveLength(2);
    const reworkPrompt = writer.calls[1]!.prompt;
    // The prior rejection is surfaced, AND the precise contract-violation steering follows it.
    expect(reworkPrompt).toContain("Previous attempt was rejected:");
    expect(reworkPrompt).toContain("CONTRACT-FILE violation");
    expect(reworkPrompt).toContain("revert ONLY the change to the contract file");
    expect(reworkPrompt).toContain("KEEP the");
    expect(reworkPrompt).toContain("Reverting the whole scaffold to no net change is NOT a fix");
  });

  // The precise contract steering is ONLY for a contract-file violation: an ordinary
  // completeness rejection (no contract file named) reworks WITHOUT the contract steering — it
  // would misdirect a writer whose change never touched a contract file.
  it("does NOT add the contract-revert steering when the rejection is not a contract-file violation", async () => {
    const writer = makeWriter(["diff a\n", "diff b\n"]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T", intent: "i", behaviorIds: ["B1"] }])]),
        writer,
        checker: makeChecker([incompleteCheck, completeCheck]),
        auditor: makeAuditor([cleanAudit, cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    const reworkPrompt = writer.calls[1]!.prompt;
    expect(reworkPrompt).toContain("Previous attempt was rejected:");
    expect(reworkPrompt).not.toContain("CONTRACT-FILE violation");
    expect(reworkPrompt).not.toContain("revert ONLY the change to the contract file");
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

  // WS-D2 (native design subsystem): the rendered design block, when present on the
  // run context, reaches the writer prompt verbatim — the no-handoff injection.
  it("injects the design context block into the writer prompt when present", async () => {
    const writer = makeWriter(["diff a\n"]);
    const base = defaultLoopInput();
    const { input } = defaultLoopInput({
      adapters: {
        ...base.input.adapters,
        planner: makePlanner([buildPlan([{ title: "T", intent: "i", behaviorIds: [] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
      context: {
        ...base.input.context,
        designContextBlock:
          "Design contract — build the product to honor this design:\nDesign identity: calm ops console",
      },
    });
    await runSubtaskLoop(input);
    const prompt = writer.calls[0]!.prompt;
    expect(prompt).toContain("Design contract — build the product to honor this design:");
    expect(prompt).toContain("Design identity: calm ops console");
  });

  // ABSENT design block ⇒ no design section in the prompt (a real empty state — never a
  // fabricated default).
  it("omits any design section from the writer prompt when no design block is present", async () => {
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
    expect(writer.calls[0]!.prompt).not.toContain("Design contract");
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
