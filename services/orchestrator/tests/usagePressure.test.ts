import { describe, expect, it } from "vitest";
import type { SubscriptionWindow } from "../src/engine/usage/contracts.js";
import { DEFAULT_WINDOW_PRESSURE_THRESHOLD, evaluateWindowPressure } from "../src/engine/usage/pressure.js";

function window(
  slot: SubscriptionWindow["slot"],
  usedPercent: number,
  resetsAt = "2026-05-30T20:19:33Z",
): SubscriptionWindow {
  return { slot, usedPercent, resetsAt, windowMinutes: 300, resetDescription: "" };
}

describe("evaluateWindowPressure", () => {
  it("defaults to the exhausted (100%) threshold", () => {
    expect(DEFAULT_WINDOW_PRESSURE_THRESHOLD).toBe(100);
  });

  it("returns the secondary window when primary 0% + secondary 100% at threshold 100", () => {
    const worst = evaluateWindowPressure([window("primary", 0), window("secondary", 100)], 100);
    expect(worst?.slot).toBe("secondary");
    expect(worst?.usedPercent).toBe(100);
  });

  it("returns null when every window is below the threshold", () => {
    expect(evaluateWindowPressure([window("primary", 0), window("secondary", 99)], 100)).toBeNull();
  });

  it("uses the default threshold when none is supplied", () => {
    expect(evaluateWindowPressure([window("primary", 100)])?.slot).toBe("primary");
    expect(evaluateWindowPressure([window("primary", 90)])).toBeNull();
  });

  it("respects a lowered threshold for early escalation", () => {
    const worst = evaluateWindowPressure([window("primary", 92), window("secondary", 40)], 90);
    expect(worst?.slot).toBe("primary");
  });

  it("picks the highest-pressure window, breaking ties by soonest reset", () => {
    const worst = evaluateWindowPressure(
      [window("primary", 100, "2026-06-01T00:00:00Z"), window("secondary", 100, "2026-05-28T00:00:00Z")],
      100,
    );
    expect(worst?.slot).toBe("secondary");
  });

  it("returns null for no windows", () => {
    expect(evaluateWindowPressure([], 100)).toBeNull();
  });
});
