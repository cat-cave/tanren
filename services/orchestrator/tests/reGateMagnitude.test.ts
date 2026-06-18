// RE-GATE MAGNITUDE (Phase-2). The merge-gate self-heal (`mergeGateSelfHeal`) and the
// review-verdict re-entry (`applyReviewVerdict`) used to escalate via a SINGLE-STEP
// signature-only fixed-point check (`atReplanFixedPoint`): the SAME `tier:step` signature
// recurring read as a fixed point and HALTED — even when the writer was genuinely CONVERGING
// (50 → 20 → 5 errors). The fix routes BOTH through the magnitude-aware `atGateFixedPoint`
// (the shared `decideConvergence`) with a stack-agnostic remaining-problem MAGNITUDE (the
// non-empty diagnostic-line count of the failing step's output), so a shrinking-error
// trajectory at an UNCHANGED signature is recognized as PROGRESS (keep reworking, UNBOUNDED)
// and only a GENUINE fixed point (same signature, no magnitude decrease) halts. No count.
import { describe, expect, it } from "vitest";
import {
  applyReviewVerdict,
  gateOutcomeAttempt,
  mergeGateSelfHeal,
} from "../src/engine/workflow/plannerRunSelfHeal.js";
import type { FinalizeRunState } from "../src/engine/workflow/plannerRunFinalize.js";
import { atGateFixedPoint, type GateAttempt, outputMagnitude } from "../src/engine/workflow/reviewMerge/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { PlannerRejectionFeedback } from "../src/engine/workflow/planner/planner.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

// A failed pre_merge gate whose failing step captured `outputTail` (the diagnostic the
// magnitude + signature are derived from). Same tier/step ⇒ same SIGNATURE only when the
// output tail is byte-identical; a shrinking output tail still hashes differently — so the
// magnitude is the trajectory axis that survives even an IDENTICAL tail.
function failGate(outputTail: string): Extract<GateOutcome, { passed: false }> {
  return {
    passed: false,
    results: [],
    failure: {
      passed: false,
      tier: "tier-3",
      when: "pre_merge",
      failedStep: "test",
      exitCode: 1,
      steps: [{ name: "test", run: "just tier-3", exitCode: 1, passed: false, timedOut: false, outputTail }],
    },
  };
}

// N distinct failing lines under the SAME header — the signature changes (different tail
// text) but the COUNT is the magnitude. To isolate the magnitude axis from the signature
// axis we ALSO build same-signature sequences below by reusing identical tails.
function errorsTail(count: number): string {
  return ["FAILURES:", ...Array.from({ length: count }, (_, i) => `  test ${i} failed`)].join("\n");
}

describe("outputMagnitude — stack-agnostic remaining-problem count", () => {
  it("counts non-empty lines (a generic 'how much is still wrong' proxy)", () => {
    expect(outputMagnitude("a\nb\nc")).toBe(3);
    // Blank / whitespace-only lines do not count.
    expect(outputMagnitude("a\n\n  \nb")).toBe(2);
  });

  it("is undefined for empty output (no meaningful magnitude — key off the signature alone)", () => {
    expect(outputMagnitude("")).toBeUndefined();
    expect(outputMagnitude("   \n  ")).toBeUndefined();
  });
});

describe("gateOutcomeAttempt — signature + magnitude", () => {
  it("the magnitude shrinks with the failing step's diagnostic-line count", () => {
    // The header line + N failure lines.
    expect(gateOutcomeAttempt(failGate(errorsTail(50))).magnitude).toBe(51);
    expect(gateOutcomeAttempt(failGate(errorsTail(5))).magnitude).toBe(6);
  });

  it("the signature is stable for an identical tier/step/output", () => {
    expect(gateOutcomeAttempt(failGate("same")).signature).toBe(gateOutcomeAttempt(failGate("same")).signature);
  });

  it("an empty output yields no magnitude (key off the signature alone)", () => {
    expect(gateOutcomeAttempt(failGate("")).magnitude).toBeUndefined();
  });
});

describe("atGateFixedPoint — magnitude-aware re-gate convergence", () => {
  const SIG = "tier-3:test";

  it("a SHRINKING magnitude at the SAME signature is PROGRESS (not a fixed point) — the 50→20→5 trajectory", async () => {
    const prior: GateAttempt[] = [
      { signature: SIG, magnitude: 50 },
      { signature: SIG, magnitude: 20 },
    ];
    // The same signature recurs a THIRD time — a signature-only path would call this a cycle
    // and HALT. With a still-shrinking magnitude it is PROGRESS.
    expect(await atGateFixedPoint(prior, { signature: SIG, magnitude: 5 })).toBe(false);
  });

  it("a GENUINE fixed point (same signature, NO magnitude decrease, recurring) escalates", async () => {
    const prior: GateAttempt[] = [
      { signature: SIG, magnitude: 7 },
      { signature: SIG, magnitude: 7 },
    ];
    expect(await atGateFixedPoint(prior, { signature: SIG, magnitude: 7 })).toBe(true);
  });
});

// A single-subtask gate rejection fixture for the merge-gate self-heal.
describe("mergeGateSelfHeal — re-gate paths recognize magnitude/trajectory progress", () => {
  it("a same-signature-but-SHRINKING-error-count sequence REWORKS at every step (never halts)", async () => {
    // The failing step's tail SHRINKS (50 → 20 → 5 → 1 lines). Even past the point a
    // signature-only cycle check would have halted (the 3rd identical-shape attempt), the
    // shrinking magnitude keeps it reworking. We thread the recorded attempts forward exactly
    // as the budget does.
    const attempts: GateAttempt[] = [];
    for (const count of [50, 20, 5, 1]) {
      const decision = await mergeGateSelfHeal(failGate(errorsTail(count)), attempts);
      expect(decision.kind).toBe("rework");
      if (decision.kind === "rework") attempts.push(decision.attempt);
    }
    expect(attempts).toHaveLength(4);
  });

  it("a pre_merge gate failing the IDENTICAL way (same output, no shrink) HALTS at a fixed point", async () => {
    const attempts: GateAttempt[] = [];
    const decisions: string[] = [];
    // The IDENTICAL failing output every time (same signature, same magnitude). The first
    // repeat is still progress (a transient may recur once); the recurrence as a cycle halts.
    for (let i = 0; i < 4; i += 1) {
      const decision = await mergeGateSelfHeal(failGate(errorsTail(5)), attempts);
      decisions.push(decision.kind);
      if (decision.kind === "rework") attempts.push(decision.attempt);
      else break;
    }
    // It reworked while there was no proven cycle, then HALTED — never an infinite loop.
    expect(decisions).toContain("halt");
    expect(decisions.at(-1)).toBe("halt");
  });
});

// A recording pool that captures the spec-status UPDATE the review rework drives.
class RecordingPool {
  readonly statusWrites: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (String(sql).startsWith("UPDATE specs SET status")) this.statusWrites.push(String(params[1]));
    return { rows: [], rowCount: 1 };
  }
}

function reviewCtx(): PlannerRunContext {
  return { runId: "run_1", specId: "spec_1", projectId: "project_1" } as unknown as PlannerRunContext;
}

function reviewRejection(reason: string): PlannerRejectionFeedback {
  return { producer: "reviewer", rejectionReason: reason, behaviorIdsFailed: [], previousSubtasks: [] };
}

// A list of N requested changes — the review analog of the gate's diagnostic-line count.
function changesRequested(count: number): string {
  return ["Requested changes:", ...Array.from({ length: count }, (_, i) => `- change ${i}`)].join("\n");
}

const noopFinalize: FinalizeRunState = () => Promise.resolve();
const noopAppend = () => Promise.resolve();

describe("applyReviewVerdict — review re-entry recognizes shrinking requested-change count", () => {
  function harness() {
    const pool = new RecordingPool();
    const input = { pool } as unknown as RunPlannerLoopInput;
    return { pool, input };
  }

  it("approved → merge", async () => {
    const { input } = harness();
    const move = await applyReviewVerdict(
      input,
      noopFinalize,
      reviewCtx(),
      noopAppend,
      { verdict: "approved", rejection: reviewRejection("") },
      [],
      [],
    );
    expect(move).toBe("merge");
  });

  it("a SHRINKING requested-change list REWORKS at every step (never halts) — same kind of trajectory as the gate", async () => {
    const { input } = harness();
    const attempts: GateAttempt[] = [];
    const seedRejections: PlannerRejectionFeedback[] = [];
    for (const count of [10, 5, 2, 1]) {
      const move = await applyReviewVerdict(
        input,
        noopFinalize,
        reviewCtx(),
        noopAppend,
        { verdict: "changes_requested", rejection: reviewRejection(changesRequested(count)) },
        seedRejections,
        attempts,
      );
      expect(move).toBe("rework");
    }
    expect(attempts).toHaveLength(4);
  });

  it("the IDENTICAL review feedback recurring (no shrink) HALTS at a fixed point", async () => {
    const { input } = harness();
    const attempts: GateAttempt[] = [];
    const seedRejections: PlannerRejectionFeedback[] = [];
    const moves: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const move = await applyReviewVerdict(
        input,
        noopFinalize,
        reviewCtx(),
        noopAppend,
        { verdict: "changes_requested", rejection: reviewRejection(changesRequested(3)) },
        seedRejections,
        attempts,
      );
      moves.push(move);
      if (move === "halt") break;
    }
    expect(moves).toContain("halt");
    expect(moves.at(-1)).toBe("halt");
  });
});
