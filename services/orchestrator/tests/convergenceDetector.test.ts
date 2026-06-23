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

  it("identical failure + identical OBSERVED work + non-shrinking magnitude is an IMMEDIATE fixed point", () => {
    // Byte-identical produced work + identical failure = the agent demonstrably reproduced
    // the identical output with no new information — a dead-end on the FIRST repeat.
    const a = sig("type-errors", { workSignature: "w", magnitude: 7 });
    const b = sig("type-errors", { workSignature: "w", magnitude: 7 });
    expect(assessStructuralProgress([a, b])).toBe("fixed_point");
  });

  it("a GROWING magnitude at the same failure+identical work is a fixed point (no forward motion)", () => {
    const a = sig("type-errors", { workSignature: "w", magnitude: 5 });
    const b = sig("type-errors", { workSignature: "w", magnitude: 9 });
    expect(assessStructuralProgress([a, b])).toBe("fixed_point");
  });

  it("a single UNOBSERVED-work repeat is NOT yet a fixed point (a transient recurrence ≠ a dead-end)", () => {
    // No observable produced work (e.g. a crash): a 2nd identical failure could be a transient
    // flake recurring once — NOT proof of a dead-end. Stays PROGRESS until a cycle is evidenced.
    expect(assessStructuralProgress([sig("crash"), sig("crash")])).toBe("progress");
  });

  it("the SAME unobserved-work failure recurring a THIRD time is a cycle ⇒ fixed point", () => {
    expect(assessStructuralProgress([sig("crash"), sig("crash"), sig("crash")])).toBe("fixed_point");
  });

  it("an A→B→A→B oscillation (alternating signatures) is a CYCLE ⇒ fixed point (not perpetual progress)", () => {
    // Each immediate neighbor DIFFERS, so the old at(-2) check called this progress forever
    // (a soft-brick). The latest B recurs the earlier B with no progress since ⇒ a cycle.
    expect(assessStructuralProgress([sig("a"), sig("b"), sig("a"), sig("b")])).toBe("fixed_point");
  });

  it("an oscillating magnitude 5→4→5→4 (same failure) is a CYCLE ⇒ fixed point", () => {
    const osc = [4, 5, 4, 5, 4].map((m) => sig("type-errors", { magnitude: m }));
    expect(assessStructuralProgress(osc)).toBe("fixed_point");
  });
});

describe("assessStructuralProgress — `minNonAdvancingRepeats` widens the immediate-neighbor floor (apex v50)", () => {
  // The activity-watchdog call site (`isWedgedNonAdvancing`) opts into a 2-neighbor floor so a
  // single mid-IO-burst identical work-signature probe (apex v50: a legitimate writer running
  // `pnpm install` whose stdout was silent while the bash subprocess ran) is not yet a wedge.
  // The writer-spec rework-loop callers (`decideConvergence` from `subtaskInnerLoop` /
  // `runFinalize` / `plannerRunRedrive` / `recovery`) keep the default (1) where a single
  // byte-identical observable-work repeat is correctly a fixed point.
  it("the default (no options) preserves the 1-neighbor floor — a single identical OBSERVED-work repeat is a fixed point", () => {
    const a = sig("err", { workSignature: "w", magnitude: 7 });
    const b = sig("err", { workSignature: "w", magnitude: 7 });
    expect(assessStructuralProgress([a, b])).toBe("fixed_point");
    expect(assessStructuralProgress([a, b], {})).toBe("fixed_point");
    expect(assessStructuralProgress([a, b], { minNonAdvancingRepeats: 1 })).toBe("fixed_point");
  });

  it("a 2-NEIGHBOR floor demotes a SINGLE identical-neighbor pair to progress (continue UNBOUNDED)", () => {
    // The apex v50 case: a single tick of identical work-signature is not yet proof of a wedge
    // — it could be one batched IO flush, one silent codex reasoning gap during a tool call.
    const a = sig("err", { workSignature: "w", magnitude: 7 });
    const b = sig("err", { workSignature: "w", magnitude: 7 });
    expect(assessStructuralProgress([a, b], { minNonAdvancingRepeats: 2 })).toBe("progress");
  });

  it("a 2-NEIGHBOR floor still fires at 2 CONSECUTIVE identical pairs (3 identical attempts in a row)", () => {
    const a = sig("err", { workSignature: "w", magnitude: 7 });
    expect(assessStructuralProgress([a, a, a], { minNonAdvancingRepeats: 2 })).toBe("fixed_point");
  });

  it("a 2-NEIGHBOR floor is NOT met when an advancing step BROKE the streak before the trailing repeat", () => {
    // [a, b, a, a]: only the last pair is identical (streak=1 at the trailing edge) — the
    // pair (b, a) genuinely changed the failure axis. So the immediate-neighbor branch must
    // NOT fire under a 2-neighbor floor (cycle detection may still catch it independently —
    // but here `a` recurs an earlier `a` with no intervening cycle, so it stays progress).
    const a = sig("a", { workSignature: "wa" });
    const b = sig("b", { workSignature: "wb" });
    expect(assessStructuralProgress([a, b, a, a], { minNonAdvancingRepeats: 2 })).toBe("progress");
  });

  it("the CYCLE branch is UNAFFECTED by `minNonAdvancingRepeats` — an A→B→A→B oscillation still surfaces a fixed point", () => {
    // The cycle detector reads a recurrence across an intervening attempt, independent of the
    // immediate-neighbor streak floor. The watchdog still catches genuine cycles even at a
    // widened floor (and the writer-spec loop is unchanged either way).
    expect(assessStructuralProgress([sig("a"), sig("b"), sig("a"), sig("b")], { minNonAdvancingRepeats: 2 })).toBe(
      "fixed_point",
    );
  });

  it("a fractional / non-integer `minNonAdvancingRepeats` is floored to 1 (default behavior preserved)", () => {
    // Defensive: 0 / negative values are meaningless (a streak can't be < 1 on the only branch
    // they gate). They MUST NOT silently disable the watchdog by always reading "progress".
    const a = sig("err", { workSignature: "w", magnitude: 7 });
    expect(assessStructuralProgress([a, a], { minNonAdvancingRepeats: 0 })).toBe("fixed_point");
    expect(assessStructuralProgress([a, a], { minNonAdvancingRepeats: -1 })).toBe("fixed_point");
  });
});

describe("PROPERTY — cycles eventually escalate; shrinking magnitude NEVER escalates", () => {
  it("alternating A,B,A,B,… with non-decreasing magnitude reaches a fixed point (no unbounded re-drive)", () => {
    // Generate the oscillation at increasing lengths; once the recurrence is visible it is a
    // fixed point and STAYS one — a 2-cycle never reports perpetual progress.
    let everFixedPoint = false;
    for (let n = 2; n <= 12; n += 1) {
      const history = Array.from({ length: n }, (_unused, i) =>
        sig(i % 2 === 0 ? "a" : "b", { magnitude: 5 + (i % 2) }),
      );
      if (assessStructuralProgress(history) === "fixed_point") everFixedPoint = true;
    }
    expect(everFixedPoint).toBe(true);
  });

  it("a monotonically SHRINKING magnitude (1000→500→…→1), all same failure, is ALWAYS progress — never escalate", () => {
    // The binding property: genuine trajectory progress re-drives UNBOUNDED. A repeated failure
    // signature with a strictly shrinking magnitude must NEVER trip cycle detection.
    const mags = [10000, 5000, 2500, 1000, 500, 250, 100, 50, 10, 5, 2, 1];
    for (let i = 2; i <= mags.length; i += 1) {
      const window = mags.slice(0, i).map((m) => sig("type-errors", { magnitude: m }));
      expect(assessStructuralProgress(window)).toBe("progress");
    }
  });

  it("a DIFFERENT failure each attempt (changing signature) is ALWAYS progress — never escalate", () => {
    const history: AttemptSignature[] = [sig("failure-0")];
    for (let i = 1; i < 50; i += 1) {
      history.push(sig(`failure-${i}`));
      expect(assessStructuralProgress(history)).toBe("progress");
    }
  });

  it("NEW produced work each attempt (same failure) is ALWAYS progress — the agent keeps doing something different", () => {
    const history: AttemptSignature[] = [sig("same", { workSignature: "w-0" })];
    for (let i = 1; i < 50; i += 1) {
      history.push(sig("same", { workSignature: `w-${i}` }));
      expect(assessStructuralProgress(history)).toBe("progress");
    }
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
    // A genuine cycle (the same unobserved-work failure recurring beyond the immediate
    // neighbor) — the no-agent stand-in renders the human-actionable diagnosis.
    const fixed = [sig("same"), sig("same"), sig("same")];
    const d = await decideConvergence(fixed, (h) =>
      fixedPointRuleJudgment(h, () => "the same X recurred — a human must Y"),
    );
    expect(d).toEqual({ decision: "escalate", reason: "the same X recurred — a human must Y" });
  });

  it("a single transient repeat (unobserved work) does NOT escalate — the judge is never consulted", async () => {
    // The disguised-K=2 fix: a 2nd identical crash with no observable work is NOT yet a fixed
    // point, so decideConvergence continues WITHOUT asking the judge (no instant escalation).
    let judgeCalls = 0;
    const d = await decideConvergence([sig("crash"), sig("crash")], () => {
      judgeCalls += 1;
      return { verdict: "escalate" as const, reason: "x" };
    });
    expect(d).toEqual({ decision: "continue" });
    expect(judgeCalls).toBe(0);
  });
});
