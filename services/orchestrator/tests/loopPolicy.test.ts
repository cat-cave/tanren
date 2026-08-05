// Pure-decision tests for the convergence policy (docs/roadmap/spec-loop-redesign.md).
// `applyConvergencePolicy` is the deterministic routing over the convergence answerer's
// assessment + the BLOCKING root-cause progress + the INTELLIGENT ESCALATION verdict + the
// CONFIGURABLE velocity-defer policy. apex v35: there is NO `maxConsecutiveStalls` count —
// the loop is UNBOUNDED while it is progressing, and HALTS only when the agent's escalation
// verdict ("would a human add value beyond 'keep going'?") says `escalate`. The
// `consecutiveStalls` field is an OBSERVABILITY diagnostic, never a bound.
import { describe, expect, it } from "vitest";
import {
  applyConvergencePolicy,
  type ConvergenceState,
  effectiveBlockingProgress,
  blockingRootCauseOscillates,
  type VelocityDeferPolicy,
} from "../src/engine/workflow/loopPolicy.js";
import type { AttemptSignature } from "../src/engine/workflow/convergenceDetector.js";
import type {
  BlockingRootCauseProgress,
  ConvergenceAssessment,
  ConvergenceEscalation,
} from "../src/engine/answerers/schemas/index.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../src/engine/config/shared.js";
import type { FindingSeverity } from "../src/engine/contracts/findings.js";

// The velocity-defer policy the redesign's DEFAULT reproduces (enabled · honor up to
// P3-mild leftovers · from round 0).
const DEFAULT_VELOCITY_POLICY: VelocityDeferPolicy = {
  enabled: DEFAULT_CONVERGENCE_POLICY.velocityDeferEnabled,
  maxSeverity: DEFAULT_CONVERGENCE_POLICY.velocityDeferMaxSeverity,
  afterStalls: DEFAULT_CONVERGENCE_POLICY.velocityDeferAfterStalls,
};

// An adapter that keeps the existing positional assertions legible while exercising the
// options-object signature. It supplies a UNIQUE non-oscillating `loopBlocking` id per call
// (so the v40 oscillation backstop never fires here — these tests cover the answerer-driven
// progress/stall semantics, NOT oscillation), starts from an empty `blockingHistory` unless
// `state` carries one, and strips `blockingHistory` from the returned state so the
// `consecutiveStalls`/`decision` assertions stay focused.
let runSeq = 0;
function run(
  assessment: ConvergenceAssessment,
  blockingProgress: BlockingRootCauseProgress,
  escalation: ConvergenceEscalation,
  state: Pick<ConvergenceState, "consecutiveStalls"> & Partial<ConvergenceState>,
  velocityPolicy: VelocityDeferPolicy,
  worstLeftoverSeverity?: FindingSeverity,
): { state: { consecutiveStalls: number }; decision: "continue" | "pass" | "halt" } {
  runSeq += 1;
  const result = applyConvergencePolicy({
    assessment,
    blockingProgress,
    escalation,
    state: { consecutiveStalls: state.consecutiveStalls, blockingHistory: state.blockingHistory ?? [] },
    velocityPolicy,
    loopBlocking: { id: `unique-blocker-${runSeq}`, pScore: 1 },
    ...(worstLeftoverSeverity !== undefined && { worstLeftoverSeverity }),
  });
  return { state: { consecutiveStalls: result.state.consecutiveStalls }, decision: result.decision };
}

describe("applyConvergencePolicy — intelligent escalation, no count bound", () => {
  it("PROGRESS with keep_going continues + resets the stall diagnostic; a velocity_defer passes", () => {
    // No blocking finding (`none`) ⇒ the overall assessment drives. With keep_going the loop
    // continues, unbounded.
    expect(run("progress", "none", "keep_going", { consecutiveStalls: 5 }, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // The DEFAULT velocity policy honors any velocity_defer (today's behavior).
    expect(
      run("velocity_defer", "none", "keep_going", { consecutiveStalls: 2 }, DEFAULT_VELOCITY_POLICY, "P3"),
    ).toEqual({ state: { consecutiveStalls: 0 }, decision: "pass" });
  });

  it("a STALL with `keep_going` CONTINUES (UNBOUNDED) — slow/hard is never a halt", () => {
    // Many stalls deep, but the agent says keep going ⇒ the loop continues, no count flips it.
    expect(run("stalled", "none", "keep_going", { consecutiveStalls: 99 }, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 100 },
      decision: "continue",
    });
  });

  it("a STALL with `escalate` HALTS (the genuine human-decision) — the diagnostic increments", () => {
    expect(run("stalled", "none", "escalate", { consecutiveStalls: 0 }, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 1 },
      decision: "halt",
    });
  });

  it("the velocity policy honors the configured max-severity (leftovers ≤ maxSeverity)", () => {
    const policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 0 };
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, policy, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // A P2 leftover is ABOVE the P3 max ⇒ the defer is REFUSED (continue, fail-closed).
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, policy, "P2")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    const p2Policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P2", afterStalls: 0 };
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, p2Policy, "P2")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, policy)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
  });

  it("the velocity policy honors after-stalls + the enabled switch", () => {
    const afterTwo: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 2 };
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 1 }, afterTwo, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 2 }, afterTwo, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    const off: VelocityDeferPolicy = { enabled: false, maxSeverity: "P3", afterStalls: 0 };
    expect(run("velocity_defer", "none", "keep_going", { consecutiveStalls: 5 }, off, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
  });

  // ---- v24 CAUSE-NOT-SYMPTOM regression -----------------------------------
  // The bug: the convergence answerer voted `progress` while its OWN reasoning said the
  // blocking P1 root cause recurred UNCHANGED — because a peripheral, non-blocking finding
  // changed each loop and reset the stall counter. The fix: the stall/escalation read tracks
  // the BLOCKING root cause (`blockingRootCauseProgress`), not "did anything change".
  describe("v24: the BLOCKING root cause drives the stall read, not peripheral churn", () => {
    it("a stuck blocker with `escalate` HALTS even though the overall assessment was `progress` (peripheral churn)", () => {
      // The exact v24 scenario: overall `progress` (peripheral findings moved), but the
      // blocking root cause is `unchanged`. The blocker drives the read — and when the agent
      // judges it a genuine dead-end, it halts (it would have churned forever pre-fix).
      const r = run("progress", "unchanged", "escalate", { consecutiveStalls: 0 }, DEFAULT_VELOCITY_POLICY, "P1");
      expect(r).toEqual({ state: { consecutiveStalls: 1 }, decision: "halt" });
    });

    it("a stuck blocker the agent still wants to keep_going CONTINUES (the blocker drives the read, not a count)", () => {
      // The blocker is unchanged but the agent has a new approach ⇒ keep going, UNBOUNDED.
      const r = run("progress", "unchanged", "keep_going", { consecutiveStalls: 7 }, DEFAULT_VELOCITY_POLICY, "P1");
      expect(r).toEqual({ state: { consecutiveStalls: 8 }, decision: "continue" });
    });

    it("a blocking `regressed` with keep_going still continues (the agent decides, not a count)", () => {
      expect(
        run("progress", "regressed", "keep_going", { consecutiveStalls: 1 }, DEFAULT_VELOCITY_POLICY, "P0"),
      ).toEqual({ state: { consecutiveStalls: 2 }, decision: "continue" });
    });

    it("velocity_defer is REFUSED while the blocking root cause is stuck (fail-closed, no pass on a stuck blocker)", () => {
      // A stuck blocker is a stall — the loop must NOT pass; the agent's keep_going continues it.
      const r = run(
        "velocity_defer",
        "unchanged",
        "keep_going",
        { consecutiveStalls: 0 },
        DEFAULT_VELOCITY_POLICY,
        "P3",
      );
      expect(r).toEqual({ state: { consecutiveStalls: 1 }, decision: "continue" });
    });

    it("a blocking root cause being RETIRED with keep_going resets the diagnostic and continues (real progress)", () => {
      expect(run("progress", "retired", "keep_going", { consecutiveStalls: 2 }, DEFAULT_VELOCITY_POLICY, "P1")).toEqual(
        {
          state: { consecutiveStalls: 0 },
          decision: "continue",
        },
      );
    });

    it("a blocking root cause REDUCED with keep_going resets the diagnostic and continues", () => {
      expect(run("stalled", "reduced", "keep_going", { consecutiveStalls: 2 }, DEFAULT_VELOCITY_POLICY, "P2")).toEqual({
        state: { consecutiveStalls: 0 },
        decision: "continue",
      });
    });

    it("a blocker retired WITH a mild remaining leftover honors velocity_defer (pass)", () => {
      expect(
        run("velocity_defer", "retired", "keep_going", { consecutiveStalls: 1 }, DEFAULT_VELOCITY_POLICY, "P3"),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "pass" });
    });
  });

  // ---- Codex critic #17: escalate ALWAYS halts, even alongside a progress signal --------
  // The prompt binds `escalate` to "human input would genuinely CHANGE the outcome" (a real
  // decision/blocker/dead-end); the prompt also explicitly forbids escalate on "slow / hard /
  // many-attempts" grounds. So an escalate paired with a progress signal is NOT the v24
  // trajectory case — it is an answerer legitimately flagging a human-decision (e.g. a
  // missing credential) while peripheral work still moves. Peripheral progress does NOT
  // unblock the reason for escalating.
  describe("critic #17: escalate takes precedence over ANY progress signal", () => {
    it("assessment=progress + escalate HALTS (no blocking finding; overall progress)", () => {
      expect(run("progress", "none", "escalate", { consecutiveStalls: 5 }, DEFAULT_VELOCITY_POLICY)).toEqual({
        state: { consecutiveStalls: 0 },
        decision: "halt",
      });
    });

    it("blocker RETIRED + escalate HALTS (blocker advanced, but the escalate reason stands)", () => {
      // The exact critic #17 shape: the answerer retired the writer-side blocker BUT still
      // reports escalate (say, a missing credential the writer cannot obtain). Pre-fix this
      // returned `continue` because `blockerAdvanced || assessment === "progress"` short-
      // circuited past the escalation check.
      expect(run("progress", "retired", "escalate", { consecutiveStalls: 2 }, DEFAULT_VELOCITY_POLICY, "P1")).toEqual({
        state: { consecutiveStalls: 0 },
        decision: "halt",
      });
    });

    it("blocker REDUCED + escalate HALTS (peripheral movement does not clear the escalation)", () => {
      expect(run("stalled", "reduced", "escalate", { consecutiveStalls: 2 }, DEFAULT_VELOCITY_POLICY, "P2")).toEqual({
        state: { consecutiveStalls: 0 },
        decision: "halt",
      });
    });

    it("velocity_defer + escalate HALTS (a defer never masks a legitimate escalation)", () => {
      expect(
        run("velocity_defer", "none", "escalate", { consecutiveStalls: 3 }, DEFAULT_VELOCITY_POLICY, "P3"),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "halt" });
    });

    it("progress + keep_going still continues (pre-existing behavior on non-escalate cases is preserved)", () => {
      // The v24 trajectory case (1000→1) — the answerer says `keep_going`; the loop keeps going.
      expect(run("progress", "none", "keep_going", { consecutiveStalls: 5 }, DEFAULT_VELOCITY_POLICY)).toEqual({
        state: { consecutiveStalls: 0 },
        decision: "continue",
      });
      expect(run("progress", "retired", "keep_going", { consecutiveStalls: 4 }, DEFAULT_VELOCITY_POLICY, "P1")).toEqual(
        { state: { consecutiveStalls: 0 }, decision: "continue" },
      );
    });
  });

  // ---- v40 OSCILLATION backstop -------------------------------------------
  // The v40 scaffold finding: the answerer kept reading "old blocker A retired + a NEW blocker
  // B appeared" as PROGRESS, never noticing B was a RETURN to an earlier blocker — an A→B→A→B
  // oscillation that ground forever. The deterministic backstop routes the per-loop
  // blocking-root-cause-id history through the shared structural cycle detector and OVERRIDES a
  // claimed-`retired` to a stall (`regressed`) when the loop has cycled back with no net P-score
  // reduction. It is NOT a count: a genuinely shrinking trajectory never trips it.
  describe("v40: a returning (oscillating) blocking root cause is detected as non-convergence", () => {
    it("forces a claimed-`retired` to `regressed` when the blocker OSCILLATES (A→B→A→B) with no net P-score drop", () => {
      // A PROVEN oscillation: A (pScore 4) → B (4) → A (4) → B (4) — the cycle has repeated, not
      // a single transient revisit (which the shared detector intentionally treats as still
      // exploring). The answerer (mis)reports `retired` this loop; the backstop's effective
      // progress is `regressed`. This is the v40 grind (it ran 13 iterations), not a one-off.
      const history: AttemptSignature[] = [
        { failureSignature: "blocker-a", magnitude: 4 },
        { failureSignature: "blocker-b", magnitude: 4 },
        { failureSignature: "blocker-a", magnitude: 4 },
        { failureSignature: "blocker-b", magnitude: 4 },
      ];
      expect(effectiveBlockingProgress("retired", history)).toBe("regressed");
      // A SINGLE return (A→B→A) is NOT yet a proven cycle — the loop may still be exploring (B
      // was new since the last A), so the reported progress is left untouched (no false stall).
      const singleReturn: AttemptSignature[] = [
        { failureSignature: "blocker-a", magnitude: 4 },
        { failureSignature: "blocker-b", magnitude: 4 },
        { failureSignature: "blocker-a", magnitude: 4 },
      ];
      expect(effectiveBlockingProgress("retired", singleReturn)).toBe("retired");
    });

    it("the oscillating loop STALLS (escalate ⇒ halt) even though the answerer narrated progress", () => {
      // Loops 1-3 establish an A→B→A history (still exploration ⇒ each `continue`); loop 4 RETURNS
      // to B, completing a PROVEN A→B→A→B cycle (the v40 grind). The answerer claims overall
      // `progress` + blocking `retired` throughout. On loop 4 the backstop converts it to a
      // stall, and the agent's escalate verdict halts (a genuine non-converging oscillation).
      let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
      const cont = (id: string, escalation: ConvergenceEscalation): { state: ConvergenceState; decision: string } =>
        applyConvergencePolicy({
          assessment: "progress",
          blockingProgress: "retired",
          escalation,
          state,
          velocityPolicy: DEFAULT_VELOCITY_POLICY,
          loopBlocking: { id, pScore: 4 },
        });
      // Loop 1: blocker A. Loop 2: B appears (A "retired"). Loop 3: A RETURNS — a single return,
      // still possibly exploration ⇒ continue. The answerer's `retired` is honored each loop.
      state = cont("justfile-redefined", "keep_going").state;
      state = cont("no-scaffold-net-change", "keep_going").state;
      const loop3 = cont("justfile-redefined", "keep_going");
      expect(loop3.decision).toBe("continue");
      state = loop3.state;
      // Loop 4: B RETURNS — the A→B→A→B cycle is now PROVEN. The backstop overrides the answerer's
      // `retired` to a stall; with the agent's escalate verdict at this oscillation, the loop HALTS.
      const loop4 = cont("no-scaffold-net-change", "escalate");
      expect(loop4.decision).toBe("halt");
    });

    it("a genuinely SHRINKING trajectory at a recurring blocker is NEVER flagged (keeps the reported progress)", () => {
      // The same blocker id recurs but the P-score strictly shrinks each loop (4 → 3 → 2): real
      // convergence, not a cycle. The backstop must NOT override the reported `reduced`.
      const history: AttemptSignature[] = [
        { failureSignature: "blocker-a", magnitude: 4 },
        { failureSignature: "blocker-a", magnitude: 3 },
        { failureSignature: "blocker-a", magnitude: 2 },
      ];
      expect(effectiveBlockingProgress("reduced", history)).toBe("reduced");
    });

    it("a loop exploring all-NEW blockers each round keeps the reported progress (no recurrence = no cycle)", () => {
      const history: AttemptSignature[] = [
        { failureSignature: "blocker-a", magnitude: 4 },
        { failureSignature: "blocker-b", magnitude: 4 },
        { failureSignature: "blocker-c", magnitude: 4 },
      ];
      expect(effectiveBlockingProgress("retired", history)).toBe("retired");
    });
  });
});

// REGRESSION — the observed run: three plan rounds, each `stalled`, each naming the SAME
// `blockingRootCauseId` ("gate-slow-codegen-drift"), each escalated `keep_going`, each decided
// `continue`. 3h42m and ~$1.73 on one run, 52 identical writer attempts, a second run stalled
// the same way, two of three benchmark tiers lost.
//
// The detector was never missing. On `main`, `assessStructuralProgress` ALREADY returns
// `fixed_point` for that exact A→A→A trajectory, and `effectiveBlockingProgress` ALREADY uses
// it to override the answerer's narration to `regressed`. The proof was computed and then
// DISCARDED: it was allowed to change what the loop called the round, but not whether the loop
// stopped. Convergence had no floor.
describe("the structural fixed point is a FLOOR under the answerer's keep_going", () => {
  const round = (
    state: ConvergenceState,
    id: string,
    pScore: number,
    escalation: ConvergenceEscalation = "keep_going",
  ): { state: ConvergenceState; decision: string } =>
    applyConvergencePolicy({
      assessment: "stalled",
      blockingProgress: "unchanged",
      escalation,
      state,
      velocityPolicy: DEFAULT_VELOCITY_POLICY,
      loopBlocking: { id, pScore },
    });

  it("HALTS once the SAME named cause is a proven fixed point, despite keep_going", () => {
    let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
    const cause = "gate-slow-codegen-drift";

    const r1 = round(state, cause, 4);
    expect(r1).toMatchObject({ decision: "continue", state: { consecutiveStalls: 1 } });
    state = r1.state;
    // Round 2: an immediate repeat alone is NOT a fixed point (it may be transient) — the
    // detector deliberately requires a recurrence across an intervening round.
    const r2 = round(state, cause, 4);
    expect(r2).toMatchObject({ decision: "continue", state: { consecutiveStalls: 2 } });
    state = r2.state;
    // Round 3 is where the observed run kept going. The trajectory now PROVES the fixed point.
    expect(blockingRootCauseOscillates([...state.blockingHistory, { failureSignature: cause, magnitude: 4 }])).toBe(
      true,
    );
    expect(round(state, cause, 4)).toMatchObject({ decision: "halt", state: { consecutiveStalls: 3 } });
  });

  it("NEGATIVE CONTROL: a SHRINKING kept P-score is never a fixed point, however many rounds", () => {
    // The property that makes this safe to ship ON by default, and the reason a COUNT would have
    // been the wrong fix. The answerer's prompt says "slow / hard / many-attempts are NEVER
    // reasons to escalate", and the v24 trajectory case (1000 → 1 errors) is real progress on one
    // stubborn cause. A round-counting floor would kill exactly the hard-but-converging runs
    // Tanren exists to finish; the structural detector cannot, because `isCycle` requires no net
    // magnitude decrease.
    let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
    for (const pScore of [40, 30, 20, 10, 4, 2]) {
      expect(round(state, "gate-slow-codegen-drift", pScore).decision).toBe("continue");
      state = round(state, "gate-slow-codegen-drift", pScore).state;
    }
    // Six consecutive stalls on ONE cause and still iterating, because the score fell every round.
    expect(state.consecutiveStalls).toBe(6);
  });

  it("NEGATIVE CONTROL: a loop still EXPLORING new causes never floors", () => {
    // A brand-new state since the last recurrence means the loop found something — `isCycle`
    // treats that as exploration, not a cycle.
    let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
    for (const cause of ["cause-a", "cause-b", "cause-c", "cause-d", "cause-e"]) {
      expect(round(state, cause, 4).decision).toBe("continue");
      state = round(state, cause, 4).state;
    }
    expect(state.consecutiveStalls).toBe(5);
  });

  it("NEGATIVE CONTROL: an UNNAMED blocker never floors — a halt must name its cause", () => {
    // "Halts are bugs" only holds as a doctrine if a halt says WHOSE bug. An empty root-cause id
    // gives the operator nothing to act on, so it is never grounds to stop even when the empty
    // signatures make the trajectory look structurally stuck.
    let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
    for (let i = 0; i < 5; i += 1) {
      expect(round(state, "", 4).decision).toBe("continue");
      state = round(state, "", 4).state;
    }
    expect(state.consecutiveStalls).toBe(5);
  });

  it("a single forward step breaks the cycle and the loop keeps running", () => {
    let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
    const cause = "gate-slow-codegen-drift";
    state = round(state, cause, 4).state;
    state = round(state, cause, 4).state;
    // Real motion on the blocker: the P-score falls, so the recurrence net-shrank.
    const advanced = applyConvergencePolicy({
      assessment: "progress",
      blockingProgress: "reduced",
      escalation: "keep_going",
      state,
      velocityPolicy: DEFAULT_VELOCITY_POLICY,
      loopBlocking: { id: cause, pScore: 2 },
    });
    expect(advanced.decision).toBe("continue");
    expect(advanced.state.consecutiveStalls).toBe(0);
    // And the next stall at the now-lower score is still not a fixed point.
    expect(round(advanced.state, cause, 2).decision).toBe("continue");
  });

  it("the floor changes only the VERDICT — an escalate still halts, progress still continues", () => {
    // Nothing about the answerer-driven paths moves. The floor adds an exit; it removes none.
    let state: ConvergenceState = { consecutiveStalls: 0, blockingHistory: [] };
    expect(round(state, "one-off", 4, "escalate").decision).toBe("halt");
    state = { consecutiveStalls: 0, blockingHistory: [] };
    expect(
      applyConvergencePolicy({
        assessment: "progress",
        blockingProgress: "retired",
        escalation: "keep_going",
        state,
        velocityPolicy: DEFAULT_VELOCITY_POLICY,
        loopBlocking: { id: "moving", pScore: 1 },
      }).decision,
    ).toBe("continue");
  });
});
