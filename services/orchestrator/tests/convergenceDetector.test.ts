// apex v35 — THE shared intelligent non-convergence detector (convergenceDetector.ts). Pins
// the binding invariant: a loop CONTINUES (unbounded) while it is making PROGRESS — a
// different failure, different produced work, OR a smaller magnitude — and is at a FIXED
// POINT only when the latest attempt is structurally indistinguishable from the prior. There
// is NO attempt count anywhere; escalation is a fixed point, judged intelligently.

import { describe, expect, it } from "vitest";
import {
  type AttemptSignature,
  assessStructuralProgress,
  decideConvergence,
  fixedPointRuleJudgment,
  fixedPointStreak,
} from "../src/engine/workflow/convergenceDetector.js";

function sig(failureSignature: string, extra?: Partial<AttemptSignature>): AttemptSignature {
  return { failureSignature, ...extra };
}

const alwaysEscalate = () => ({ verdict: "escalate" as const, reason: "dead end" });
const neverEscalate = () => ({ verdict: "keep_going" as const });

describe("assessStructuralProgress — progress (continue) vs fixed point (consider escalate)", () => {
  it("an empty / single-attempt history is `first` (always continue)", () => {
    expect(assessStructuralProgress([])).toBe("first");
    expect(assessStructuralProgress([sig("x")])).toBe("first");
  });

  it("a CHANGED failure signature is PROGRESS (continue)", () => {
    expect(assessStructuralProgress([sig("a"), sig("b")])).toBe("progress");
  });

  it("CHANGED produced work (same failure) is PROGRESS (the agent did something different)", () => {
    expect(assessStructuralProgress([sig("a", { workSignature: "w1" }), sig("a", { workSignature: "w2" })])).toBe(
      "progress",
    );
  });

  it("a SHRINKING magnitude (same failure, same/no work) is PROGRESS — the 1000 → 1 trajectory", () => {
    const history = [sig("type-errors", { magnitude: 1000 }), sig("type-errors", { magnitude: 500 })];
    expect(assessStructuralProgress(history)).toBe("progress");
  });

  it("a long trajectory 1000 → 500 → 100 → 1 is PROGRESS at EVERY step (UNBOUNDED, never a fixed point)", () => {
    const mags = [1000, 500, 100, 1];
    for (let i = 1; i < mags.length; i += 1) {
      const window = mags.slice(0, i + 1).map((m) => sig("type-errors", { magnitude: m }));
      expect(assessStructuralProgress(window)).toBe("progress");
    }
  });

  it("identical failure + identical work + non-shrinking magnitude is a FIXED POINT", () => {
    const a = sig("type-errors", { workSignature: "w", magnitude: 7 });
    const b = sig("type-errors", { workSignature: "w", magnitude: 7 });
    expect(assessStructuralProgress([a, b])).toBe("fixed_point");
  });

  it("a GROWING magnitude at the same failure+work is a fixed point (no forward motion)", () => {
    const a = sig("type-errors", { workSignature: "w", magnitude: 5 });
    const b = sig("type-errors", { workSignature: "w", magnitude: 9 });
    expect(assessStructuralProgress([a, b])).toBe("fixed_point");
  });
});

describe("fixedPointStreak — diagnostic, NOT a bound", () => {
  it("0 while the latest is progress", () => {
    expect(fixedPointStreak([sig("a"), sig("b")])).toBe(0);
  });
  it("counts the trailing identical run", () => {
    expect(fixedPointStreak([sig("a"), sig("a"), sig("a")])).toBe(2);
  });
  it("a single progressing step anywhere resets the trailing streak", () => {
    expect(fixedPointStreak([sig("a"), sig("a"), sig("b")])).toBe(0);
  });
});

describe("decideConvergence — continue while progressing (UNBOUNDED), escalate only at a fixed point", () => {
  it("a progressing loop NEVER invokes the judge and ALWAYS continues — even after 1000 attempts", async () => {
    const history: AttemptSignature[] = [];
    let judgeCalls = 0;
    const judge = () => {
      judgeCalls += 1;
      return { verdict: "escalate" as const, reason: "x" };
    };
    for (let i = 0; i < 1000; i += 1) {
      // A different failure each attempt = progress.
      history.push(sig(`failure-${i}`));
      const d = await decideConvergence(history, judge);
      expect(d.decision).toBe("continue");
    }
    // The judge is never even consulted while progressing.
    expect(judgeCalls).toBe(0);
  });

  it("at a FIXED POINT, the judge decides: keep_going → continue; escalate → escalate (with a reason)", async () => {
    const fixed = [sig("same", { workSignature: "w" }), sig("same", { workSignature: "w" })];
    expect(await decideConvergence(fixed, neverEscalate)).toEqual({ decision: "continue" });
    expect(await decideConvergence(fixed, alwaysEscalate)).toEqual({ decision: "escalate", reason: "dead end" });
  });

  it("the principled fixed-point rule escalates with a specific diagnosis (no count)", async () => {
    const fixed = [sig("same"), sig("same")];
    const d = await decideConvergence(fixed, (h) =>
      fixedPointRuleJudgment(h, () => "the same X recurred — a human must Y"),
    );
    expect(d).toEqual({ decision: "escalate", reason: "the same X recurred — a human must Y" });
  });
});
