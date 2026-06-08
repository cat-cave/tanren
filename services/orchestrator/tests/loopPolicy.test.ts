// Pure-decision tests for the convergence policy (docs/roadmap/spec-loop-redesign.md).
// `applyConvergencePolicy` is the deterministic routing over the convergence answerer's
// assessment + the consecutive-stall counter + the CONFIGURABLE velocity-defer policy
// (the SOLE loop bound — NOT a retry cap). Split out of plannerLoop.test.ts to keep
// each test file under the 500-line architecture cap.
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
    expect(applyConvergencePolicy("progress", { consecutiveStalls: 1 }, 3, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // The DEFAULT velocity policy honors any velocity_defer (today's behavior).
    expect(
      applyConvergencePolicy("velocity_defer", { consecutiveStalls: 2 }, 3, DEFAULT_VELOCITY_POLICY, "P3"),
    ).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // One short of the bound ⇒ continue (a single stall is NOT a halt).
    expect(applyConvergencePolicy("stalled", { consecutiveStalls: 1 }, 3, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 2 },
      decision: "continue",
    });
    // Reaching the bound ⇒ halt.
    expect(applyConvergencePolicy("stalled", { consecutiveStalls: 2 }, 3, DEFAULT_VELOCITY_POLICY)).toEqual({
      state: { consecutiveStalls: 3 },
      decision: "halt",
    });
  });

  it("the velocity policy honors the configured max-severity (leftovers ≤ maxSeverity)", () => {
    const policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 0 };
    // A P3 leftover is at-or-below the P3 max ⇒ the defer is HONORED (pass).
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 0 }, 3, policy, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // A P2 leftover is ABOVE the P3 max ⇒ the defer is REFUSED (continue, fail-closed).
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 0 }, 3, policy, "P2")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // Raising the max to P2 lets the P2 leftover defer.
    const p2Policy: VelocityDeferPolicy = { enabled: true, maxSeverity: "P2", afterStalls: 0 };
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 0 }, 3, p2Policy, "P2")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // No kept leftovers (undefined) ⇒ the severity gate is vacuously satisfied.
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 0 }, 3, policy)).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
  });

  it("the velocity policy honors after-stalls + the enabled switch", () => {
    const afterTwo: VelocityDeferPolicy = { enabled: true, maxSeverity: "P3", afterStalls: 2 };
    // Below the after-stalls floor ⇒ the defer is REFUSED (keep iterating first).
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 1 }, 3, afterTwo, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
    // At-or-above the floor ⇒ HONORED.
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 2 }, 3, afterTwo, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "pass",
    });
    // Disabled ⇒ never honored, regardless of severity/stalls.
    const off: VelocityDeferPolicy = { enabled: false, maxSeverity: "P3", afterStalls: 0 };
    expect(applyConvergencePolicy("velocity_defer", { consecutiveStalls: 5 }, 3, off, "P3")).toEqual({
      state: { consecutiveStalls: 0 },
      decision: "continue",
    });
  });
});
