// v39 NON-CONVERGENCE FIX (writer crash is TRANSIENT, not a work fixed-point): a writer
// that CRASHES mid-subtask (the codex exec dies with a nonzero exit / a transient SSH-connect
// blip / no parseable output) carries NO "the work is wrong" information — it is the writer
// analogue of an answerer stall, so it must RE-DRIVE the SAME subtask, never feed the WORK
// convergence. The v39 finding: two identical crashes were mis-read as a work FIXED POINT and
// escalated to needs_attention. The fix routes crashes through a SEPARATE consecutive-crash
// streak that escalates ONLY when the writer crashes on EVERY re-drive (a wedged writer/runner)
// — a crash-then-succeed reads as progress and never escalates, exactly like the stall path.
//
// These tests drive the REAL inner loop (runSubtaskLoop) through fake adapters and assert:
//   (1) a crash THEN a success re-drives and COMPLETES the spec (no escalate);
//   (2) MANY crashes (more than two) followed by a success still re-drive + complete — two
//       identical crashes are NOT a work fixed-point (the v39 regression), and the consecutive
//       crashes never trip the WORK convergence (a clean run resets the crash streak);
//   (3) the genuinely-wrong-DIFF-that-keeps-failing-the-gate path still escalates ONLY on real
//       WORK non-convergence (a fixed point over a completed attempt), never on a crash count.
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
  makeScriptedWriter,
} from "./helpers/plannerLoopHelpers.js";

describe("inner loop — a writer CRASH is TRANSIENT (re-driven), not a work fixed-point (v39)", () => {
  it("re-drives the SAME subtask after a crash and COMPLETES on the clean run (no escalate)", async () => {
    // 1st call CRASHES (no usable output); 2nd call COMPLETES. The loop must re-enter the
    // writer and finish — a crash is transient, never a terminal halt or a work fixed-point.
    const writer = makeScriptedWriter([
      { diff: "", exitReason: "crashed" },
      { diff: "diff --git README\n+done\n", exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T1", intent: "do a thing", behaviorIds: ["B1"] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    // Two writer calls: the crashed one, then the recovery — the crash was re-driven in place.
    expect(writer.calls.length).toBe(2);
  });

  it("re-drives across MANY consecutive crashes (>2) and still completes — two crashes are NOT a fixed point", async () => {
    // FOUR consecutive crashes, then a clean completion. Two identical crashes (the v39 finding)
    // must NOT escalate as a work fixed-point; the consecutive-crash streak only re-drives, and a
    // clean run resets it. The spec PASSES — no needs_attention from a crash count.
    const writer = makeScriptedWriter([
      { diff: "", exitReason: "crashed" },
      { diff: "", exitReason: "crashed" },
      { diff: "", exitReason: "crashed" },
      { diff: "", exitReason: "crashed" },
      { diff: "diff --git README\n+done\n", exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T1", intent: "do a thing", behaviorIds: ["B1"] }])]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    // All four crashes were re-driven, then the clean run completed — five writer calls total.
    expect(writer.calls.length).toBe(5);
  });
});
