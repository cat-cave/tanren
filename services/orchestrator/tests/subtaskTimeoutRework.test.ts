// apex-v36 NON-CONVERGENCE FIX (writer mid-subtask timeout): a writer that TIMES OUT
// mid-subtask must NOT have the IDENTICAL subtask re-run to ANOTHER identical timeout (the
// apex-v36 "writer again hit a fixed point with identical output/rejection and timed out
// mid-subtask" loop). The next attempt must be DIFFERENT — steered to CHANGE APPROACH
// (commit partial progress, do the smallest next increment) rather than re-attempt the
// whole subtask from scratch.
//
// These tests drive the REAL inner loop (runSubtaskLoop) through fake adapters and assert:
//   (1) after a timeout, the FOLLOWING writer prompt carries the changed-approach steering
//       (the subtask was too large; commit partial progress; smallest next increment) —
//       proving the next attempt is informed + different, not a blind identical re-run;
//   (2) `writerFailureReason` is stack-agnostic — it bakes in NO tool / scope literals.
import { describe, expect, it } from "vitest";
import { writerFailureReason } from "../src/engine/workflow/subtaskInnerLoop.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeScriptedWriter,
} from "./helpers/plannerLoopHelpers.js";

describe("inner loop — writer mid-subtask timeout leads to a CHANGED next attempt (apex-v36)", () => {
  it("feeds the post-timeout writer the change-approach steering instead of re-running the identical subtask", async () => {
    // 1st call TIMES OUT (a usable partial diff); 2nd call COMPLETES. The loop must re-enter
    // the writer with CHANGED steering after the timeout — not the identical original prompt.
    const writer = makeScriptedWriter([
      { diff: "diff --git README\n+partial\n", exitReason: "timeout" },
      { diff: "diff --git README\n+partial\n+done\n", exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "Big task", intent: "do a large thing", behaviorIds: ["B1"] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // Two writer calls: the timed-out one, then the recovery.
    expect(writer.calls.length).toBeGreaterThanOrEqual(2);
    const firstPrompt = writer.calls[0].prompt;
    const secondPrompt = writer.calls[1].prompt;

    // The FIRST attempt had no rework steering (it's the initial subtask).
    expect(firstPrompt).not.toContain("TIMED OUT mid-subtask");
    // The SECOND attempt is DIFFERENT — it carries the change-approach steering so the writer
    // commits partial progress + does the smallest next increment, never an identical re-run.
    expect(secondPrompt).not.toBe(firstPrompt);
    expect(secondPrompt).toContain("Previous attempt was rejected:");
    expect(secondPrompt).toContain("TIMED OUT mid-subtask");
    expect(secondPrompt).toContain("COMMIT the partial progress");
    expect(secondPrompt).toContain("SMALLEST next increment");
    expect(secondPrompt).toContain("do NOT re-attempt the whole subtask");
  });
});

describe("writerFailureReason — actionable, stack-agnostic timeout/crash steering", () => {
  it("a TIMEOUT steers a changed approach: commit partial progress + smallest next increment", () => {
    const reason = writerFailureReason("timeout");
    expect(reason).toContain("TIMED OUT mid-subtask");
    expect(reason).toContain("CHANGE APPROACH");
    expect(reason).toContain("COMMIT the partial progress");
    expect(reason).toContain("SMALLEST next increment");
    expect(reason).toContain("do NOT restart from scratch");
    // Stack-agnostic: no baked-in tool / package-manager / language literals.
    expect(reason.toLowerCase()).not.toContain("prettier");
    expect(reason.toLowerCase()).not.toContain("pnpm");
    expect(reason.toLowerCase()).not.toContain("npm");
  });

  // apex-v76 EXTENSION: when a stale plan hands the writer a mega-intent bundling
  // multiple product concerns (v76's shortener form + redirect route + analytics
  // page + Slack handler stalled 20+ times), the timeout steering must ALSO tell
  // the writer to tackle ONE concern per attempt and let the next planner iteration
  // split off the remaining concerns. The doctrinal reinforcement rides on the
  // same steering string — no separate seam.
  it("a TIMEOUT also carries the apex-v76 split-recovery hint for multi-concern mega-intents", () => {
    const reason = writerFailureReason("timeout");
    // Both the original commit+increment steering AND the new one-concern hint
    // must be present — the split-recovery hint reinforces, not replaces.
    expect(reason).toContain("COMMIT the partial progress");
    expect(reason).toContain("SMALLEST next increment");
    // The apex-v76 one-concern-per-attempt hint.
    expect(reason).toContain("MULTIPLE product concerns");
    expect(reason).toContain("ONLY ONE concern in this attempt");
    expect(reason).toContain("next planner iteration");
    expect(reason).toContain("split off the remaining concerns");
    // Still stack-agnostic — the example list is illustrative, not a baked-in
    // tool/language literal that couples the steering to a stack.
    expect(reason.toLowerCase()).not.toContain("prettier");
    expect(reason.toLowerCase()).not.toContain("pnpm");
    expect(reason.toLowerCase()).not.toContain("npm ");
  });

  it("a CRASH steers a re-attempt that commits progress as it goes", () => {
    const reason = writerFailureReason("crashed");
    expect(reason).toContain("CRASHED mid-subtask");
    expect(reason).toContain("committing progress as you go");
  });
});
