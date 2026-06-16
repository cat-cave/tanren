// Pure-decision tests for the convergence policy (docs/roadmap/spec-loop-redesign.md).
// `applyConvergencePolicy` is the deterministic routing over the convergence answerer's
// assessment + the BLOCKING root-cause progress + the INTELLIGENT ESCALATION verdict + the
// CONFIGURABLE velocity-defer policy. apex v35: there is NO `maxConsecutiveStalls` count —
// the loop is UNBOUNDED while it is progressing, and HALTS only when the agent's escalation
// verdict ("would a human add value beyond 'keep going'?") says `escalate`. The
// `consecutiveStalls` field is an OBSERVABILITY diagnostic, never a bound.
import { describe, expect, it } from "vitest";
import { applyConvergencePolicy, type VelocityDeferPolicy } from "../src/engine/workflow/loopPolicy.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../src/engine/config/shared.js";

// The velocity-defer policy the redesign's DEFAULT reproduces (enabled · honor up to
// P3-mild leftovers · from round 0).
const DEFAULT_VELOCITY_POLICY: VelocityDeferPolicy = {
  enabled: DEFAULT_CONVERGENCE_POLICY.velocityDeferEnabled,
  maxSeverity: DEFAULT_CONVERGENCE_POLICY.velocityDeferMaxSeverity,
  afterStalls: DEFAULT_CONVERGENCE_POLICY.velocityDeferAfterStalls,
};

describe("applyConvergencePolicy — intelligent escalation, no count bound", () => {
  it("PROGRESS continues + resets the stall diagnostic; a velocity_defer passes; the escalation verdict is ignored while progressing", () => {
    // No blocking finding (`none`) ⇒ the overall assessment drives. PROGRESS continues even if
    // the agent (irrelevantly) said escalate — a progressing loop is NEVER halted.
    expect(
      applyConvergencePolicy("progress", "none", "escalate", { consecutiveStalls: 5 }, DEFAULT_VELOCITY_POLICY),
    ).toEqual({ state: { consecutiveStalls: 0 }, decision: "continue" });
    // The DEFAULT velocity policy honors any velocity_defer (today's behavior).
    expect(
      applyConvergencePolicy(
        "velocity_defer",
        "none",
        "keep_going",
        { consecutiveStalls: 2 },
        DEFAULT_VELOCITY_POLICY,
        "P3",
      ),
    ).toEqual({ state: { consecutiveStalls: 0 }, decision: "pass" });
  });

  it("a STALL with `keep_going` CONTINUES (UNBOUNDED) — slow/hard is never a halt", () => {
    // Many stalls deep, but the agent says keep going ⇒ the loop continues, no count flips it.
    expect(
      applyConvergencePolicy("stalled", "none", "keep_going", { consecutiveStalls: 99 }, DEFAULT_VELOCITY_POLICY),
    ).toEqual({ state: { consecutiveStalls: 100 }, decision: "continue" });
  });

  it("a STALL with `escalate` HALTS (the genuine human-decision) — the diagnostic increments", () => {
    expect(
      applyConvergencePolicy("stalled", "none", "escalate", { consecutiveStalls: 0 }, DEFAULT_VELOCITY_POLICY),
    ).toEqual({ state: { consecutiveStalls: 1 }, decision: "halt" });
  });

  it("the velocity policy honors the configured max-severity (leftovers ≤ maxSeverity)", () => {
    const policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 0 };
    expect(
      applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, policy, "P3"),
    ).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // A P2 leftover is ABOVE the P3 max ⇒ the defer is REFUSED (continue, fail-closed).
    expect(
      applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, policy, "P2"),
    ).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    const p2Policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P2", afterStalls: 0 };
    expect(
      applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, p2Policy, "P2"),
    ).toEqual({ state: { consecutiveStalls: 0 }, decision: "pass" });
    expect(applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 0 }, policy)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
  });

  it("the velocity policy honors after-stalls + the enabled switch", () => {
    const afterTwo: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 2 };
    expect(
      applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 1 }, afterTwo, "P3"),
    ).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    expect(
      applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 2 }, afterTwo, "P3"),
    ).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    const off: VelocityDeferPolicy = { enabled: false, maxSeverity: "P3", afterStalls: 0 };
    expect(applyConvergencePolicy("velocity_defer", "none", "keep_going", { consecutiveStalls: 5 }, off, "P3")).toEqual(
      {
        state: { consecutiveStalls: 0 },
        decision: "continue",
      },
    );
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
      const r = applyConvergencePolicy(
        "progress",
        "unchanged",
        "escalate",
        { consecutiveStalls: 0 },
        DEFAULT_VELOCITY_POLICY,
        "P1",
      );
      expect(r).toEqual({ state: { consecutiveStalls: 1 }, decision: "halt" });
    });

    it("a stuck blocker the agent still wants to keep_going CONTINUES (the blocker drives the read, not a count)", () => {
      // The blocker is unchanged but the agent has a new approach ⇒ keep going, UNBOUNDED.
      const r = applyConvergencePolicy(
        "progress",
        "unchanged",
        "keep_going",
        { consecutiveStalls: 7 },
        DEFAULT_VELOCITY_POLICY,
        "P1",
      );
      expect(r).toEqual({ state: { consecutiveStalls: 8 }, decision: "continue" });
    });

    it("a blocking `regressed` with keep_going still continues (the agent decides, not a count)", () => {
      expect(
        applyConvergencePolicy(
          "progress",
          "regressed",
          "keep_going",
          { consecutiveStalls: 1 },
          DEFAULT_VELOCITY_POLICY,
          "P0",
        ),
      ).toEqual({ state: { consecutiveStalls: 2 }, decision: "continue" });
    });

    it("velocity_defer is REFUSED while the blocking root cause is stuck (fail-closed, no pass on a stuck blocker)", () => {
      // A stuck blocker is a stall — the loop must NOT pass; the agent's keep_going continues it.
      const r = applyConvergencePolicy(
        "velocity_defer",
        "unchanged",
        "keep_going",
        { consecutiveStalls: 0 },
        DEFAULT_VELOCITY_POLICY,
        "P3",
      );
      expect(r).toEqual({ state: { consecutiveStalls: 1 }, decision: "continue" });
    });

    it("a blocking root cause being RETIRED resets the diagnostic and continues (real progress, escalation ignored)", () => {
      expect(
        applyConvergencePolicy(
          "progress",
          "retired",
          "escalate",
          { consecutiveStalls: 2 },
          DEFAULT_VELOCITY_POLICY,
          "P1",
        ),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "continue" });
    });

    it("a blocking root cause REDUCED (lower severity) resets the diagnostic and continues", () => {
      expect(
        applyConvergencePolicy(
          "stalled",
          "reduced",
          "escalate",
          { consecutiveStalls: 2 },
          DEFAULT_VELOCITY_POLICY,
          "P2",
        ),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "continue" });
    });

    it("a blocker retired WITH a mild remaining leftover honors velocity_defer (pass)", () => {
      expect(
        applyConvergencePolicy(
          "velocity_defer",
          "retired",
          "keep_going",
          { consecutiveStalls: 1 },
          DEFAULT_VELOCITY_POLICY,
          "P3",
        ),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "pass" });
    });
  });
});
