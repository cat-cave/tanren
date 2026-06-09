// Pure-decision tests for the convergence policy (docs/roadmap/spec-loop-redesign.md).
// `applyConvergencePolicy` is the deterministic routing over the convergence answerer's
// assessment + the BLOCKING root-cause progress + the consecutive-stall counter + the
// CONFIGURABLE velocity-defer policy (the SOLE loop bound — NOT a retry cap). Split out
// of plannerLoop.test.ts to keep each test file under the 500-line architecture cap.
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

describe("applyConvergencePolicy — the SOLE loop bound", () => {
  it("progress/velocity reset the counter; stalled increments and halts at the bound", () => {
    // No blocking finding (`none`) ⇒ the overall assessment drives the counter.
    expect(applyConvergencePolicy("progress", "none", { consecutiveStalls: 1 }, 3, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // The DEFAULT velocity policy honors any velocity_defer (today's behavior).
    expect(
      applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 2 }, 3, DEFAULT_VELOCITY_POLICY, "P3"),
    ).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // One short of the bound ⇒ continue (a single stall is NOT a halt).
    expect(applyConvergencePolicy("stalled", "none", { consecutiveStalls: 1 }, 3, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 2 },
      decision: "continue",
    });
    // Reaching the bound ⇒ halt.
    expect(applyConvergencePolicy("stalled", "none", { consecutiveStalls: 2 }, 3, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 3 },
      decision: "halt",
    });
  });

  it("the velocity policy honors the configured max-severity (leftovers ≤ maxSeverity)", () => {
    const policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 0 };
    // A P3 leftover is at-or-below the P3 max ⇒ the defer is HONORED (pass).
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 0 }, 3, policy, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // A P2 leftover is ABOVE the P3 max ⇒ the defer is REFUSED (continue, fail-closed).
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 0 }, 3, policy, "P2")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // Raising the max to P2 lets the P2 leftover defer.
    const p2Policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P2", afterStalls: 0 };
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 0 }, 3, p2Policy, "P2")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // No kept leftovers (undefined) ⇒ the severity gate is vacuously satisfied.
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 0 }, 3, policy)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
  });

  it("the velocity policy honors after-stalls + the enabled switch", () => {
    const afterTwo: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 2 };
    // Below the after-stalls floor ⇒ the defer is REFUSED (keep iterating first).
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 1 }, 3, afterTwo, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // At-or-above the floor ⇒ HONORED.
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 2 }, 3, afterTwo, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // Disabled ⇒ never honored, regardless of severity/stalls.
    const off: VelocityDeferPolicy = { enabled: false, maxSeverity: "P3", afterStalls: 0 };
    expect(applyConvergencePolicy("velocity_defer", "none", { consecutiveStalls: 5 }, 3, off, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
  });

  // ---- v24 CAUSE-NOT-SYMPTOM regression -----------------------------------
  // The bug: the convergence answerer voted `progress` while its OWN reasoning said the
  // blocking P1 root cause recurred UNCHANGED — because a peripheral, non-blocking
  // finding (an unrelated pnpm-lock fix) changed each loop and reset the stall counter.
  // So a blocking root cause that never resolves could churn FOREVER. The fix: the
  // stall counter tracks the BLOCKING root cause (`blockingRootCauseProgress`), not
  // "did anything change".
  describe("v24: the BLOCKING root cause drives the stall counter, not peripheral churn", () => {
    it("a blocking root cause UNCHANGED across N loops STALLS — even with peripheral progress each round", () => {
      // The exact v24 scenario: every loop the answerer reads `progress` (peripheral
      // findings moved), but the blocking root cause (`pnpm-test-fails`) is `unchanged`.
      // The counter must INCREMENT on the blocker, NOT reset on the peripheral progress.
      const maxConsecutiveStalls = 3;
      let state = { consecutiveStalls: 0 };
      const decisions: string[] = [];
      // Simulate 4 loops (the v24 cycle count) with overall `progress` + blocker unchanged.
      for (let i = 0; i < maxConsecutiveStalls; i++) {
        const r = applyConvergencePolicy(
          "progress",
          "unchanged",
          state,
          maxConsecutiveStalls,
          DEFAULT_VELOCITY_POLICY,
          "P1",
        );
        state = r.state;
        decisions.push(r.decision);
      }
      // The counter climbed strictly with the blocker, never reset by peripheral progress…
      expect(state.consecutiveStalls).toBe(maxConsecutiveStalls);
      // …and the loop HALTS at the bound (it would have churned forever pre-fix).
      expect(decisions).toEqual(["continue", "continue", "halt"]);
    });

    it("a blocking `regressed` also counts as a stall (the blocker got worse)", () => {
      expect(
        applyConvergencePolicy("progress", "regressed", { consecutiveStalls: 1 }, 3, DEFAULT_VELOCITY_POLICY, "P0"),
      ).toEqual({ state: { consecutiveStalls: 2 }, decision: "continue" });
    });

    it("velocity_defer is REFUSED while the blocking root cause is stuck (fail-closed, no pass on a stuck blocker)", () => {
      // Even though the answerer wanted to velocity-defer, a stuck blocker is a stall —
      // the loop must NOT pass; it increments + continues (eventually halts).
      const r = applyConvergencePolicy(
        "velocity_defer",
        "unchanged",
        { consecutiveStalls: 0 },
        3,
        DEFAULT_VELOCITY_POLICY,
        "P3",
      );
      expect(r).toEqual({ state: { consecutiveStalls: 1 }, decision: "continue" });
    });

    it("a blocking root cause being RETIRED resets the counter and continues (real progress)", () => {
      // Forward motion on the blocker resets even a high prior stall count.
      expect(
        applyConvergencePolicy("progress", "retired", { consecutiveStalls: 2 }, 3, DEFAULT_VELOCITY_POLICY, "P1"),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "continue" });
    });

    it("a blocking root cause REDUCED (lower severity) resets the counter and continues", () => {
      // The blocker materially shrank — that is progress on the blocker itself.
      expect(
        applyConvergencePolicy("stalled", "reduced", { consecutiveStalls: 2 }, 3, DEFAULT_VELOCITY_POLICY, "P2"),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "continue" });
    });

    it("a blocker retired WITH a mild remaining leftover honors velocity_defer (pass)", () => {
      // Blocker advanced (reset), overall read is velocity_defer, mild leftover ⇒ pass.
      expect(
        applyConvergencePolicy("velocity_defer", "retired", { consecutiveStalls: 1 }, 3, DEFAULT_VELOCITY_POLICY, "P3"),
      ).toEqual({ state: { consecutiveStalls: 0 }, decision: "pass" });
    });
  });
});
